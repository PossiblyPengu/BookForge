import Foundation
import ReadiumZIPFoundation
import UniformTypeIdentifiers

/// Export/restore the library as a single zip — same container layout as the
/// PWA (`data.json` + `files/` + `covers/`), so a backup is portable. iOS
/// records are marked `platform: "ios"`; the restore path also understands
/// web backups and maps their records onto native `Book`s.
@MainActor
final class BackupStore {
    enum BackupError: LocalizedError {
        case notAZip, missingIndex, foreign, futureVersion, missingPayload

        var errorDescription: String? {
            switch self {
            case .notAZip: return "That file isn't a Pageturner backup (not a zip)."
            case .missingIndex: return "Not a Pageturner backup (missing data.json)."
            case .foreign: return "That zip isn't a Pageturner backup."
            case .futureVersion: return "This backup was made by a newer version of Pageturner."
            case .missingPayload: return "A book's file wasn't in the backup."
            }
        }
    }

    /// (restored, skipped)
    typealias RestoreResult = (restored: Int, skipped: Int)

    private let library: LibraryStore
    private let fm = FileManager.default

    init(library: LibraryStore) { self.library = library }

    private var booksDir: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Books", isDirectory: true)
    }

    // MARK: - Export

    /// Writes `pageturner-backup-<date>.zip` into the temp directory and
    /// returns it for the share sheet. Entries are stored, not compressed —
    /// ebooks and audio already are, so deflating buys nothing.
    func exportBackup() async throws -> URL {
        // snapshot everything the detached worker needs while on MainActor
        let books = library.books
        let files: [(name: String, url: URL)] = books.flatMap { b in
            library.fileURLs(for: b).map { ($0.lastPathComponent, $0) }
        }
        let covers: [(name: String, url: URL)] = books.map {
            ($0.id.uuidString, library.coverURL(for: $0))
        }
        let bookData = books.compactMap { b -> [String: Any]? in
            guard let d = try? JSONEncoder().encode(b),
                  var o = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            else { return nil }
            // Web-compatible fields so this backup also restores into the
            // PWA: fileKeys point at the files/ entries, dates become ms,
            // progress is the {fraction, positionSec} shape the web uses.
            let names = b.fileNames.isEmpty ? [b.fileName] : b.fileNames
            o["kind"] = b.isAudio ? "audio" : "book"
            o["format"] = b.ext.uppercased()
            o["fileKey"] = b.fileName
            o["fileKeys"] = names
            o["hasCover"] = fm.fileExists(atPath: library.coverURL(for: b).path)
            o["addedAt"] = Int(b.addedAt.timeIntervalSince1970 * 1000)
            if let lo = b.lastOpenedAt {
                o["lastOpenedAt"] = Int(lo.timeIntervalSince1970 * 1000)
            }
            o["progress"] = [
                "fraction": b.progression ?? 0,
                "positionSec": b.audioPosition ?? 0,
            ]
            return o
        }
        let stamp = ISO8601DateFormatter.string(
            from: Date(), timeZone: .current, formatOptions: [.withFullDate])
        let dest = fm.temporaryDirectory.appendingPathComponent("pageturner-backup-\(stamp).zip")

        return try await Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            try? fm.removeItem(at: dest)
            let archive = try await Archive(url: dest, accessMode: .create)

            var fileMeta: [String: [String: Any]] = [:]
            var entries: [(name: String, url: URL)] = []
            var coverEntries: [(name: String, url: URL)] = []
            for f in files where fm.fileExists(atPath: f.url.path) {
                let size = (try? f.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                let mime = UTType(filenameExtension: f.url.pathExtension)?.preferredMIMEType ?? ""
                fileMeta[f.name] = ["name": f.name, "size": size, "type": mime]
                entries.append(("files/\(f.name)", f.url))
            }
            for c in covers where fm.fileExists(atPath: c.url.path) {
                coverEntries.append(("covers/\(c.name)", c.url))
            }

            let index: [String: Any] = [
                "v": 1,
                "app": "pageturner",
                "platform": "ios",
                "exportedAt": Int(Date().timeIntervalSince1970 * 1000),
                "books": bookData,
                "fileMeta": fileMeta,
            ]
            let indexData = try JSONSerialization.data(withJSONObject: index, options: .prettyPrinted)
            try await archive.addEntry(
                with: "data.json", type: .file,
                uncompressedSize: Int64(indexData.count),
                provider: { _, _ in indexData }
            )
            for (name, url) in entries + coverEntries {
                try await archive.addEntry(with: name, fileURL: url, compressionMethod: .none)
            }
            return dest
        }.value
    }

    // MARK: - Import

    /// Restores a backup made by this app or the PWA. Books merge into the
    /// library — a book already present is skipped, not duplicated.
    func importBackup(_ url: URL) async throws -> RestoreResult {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let tmp = fm.temporaryDirectory.appendingPathComponent("restore-\(UUID().uuidString)")
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tmp) }

        // stage the archive off the main thread — failures can't orphan
        // copies because nothing lands in Books/ until a record maps cleanly
        let staged = try await Task.detached(priority: .userInitiated) {
            try await self.stage(url, into: tmp)
        }.value

        var restored = 0
        var skipped = 0
        for rec in staged.books {
            do {
                if rec["fileName"] != nil {
                    try restoreNative(rec, staged: staged)
                } else {
                    try restoreWeb(rec, staged: staged)
                }
                restored += 1
            } catch {
                skipped += 1
            }
        }
        return (restored, skipped)
    }

    private struct Staged {
        var books: [[String: Any]]
        var fileMeta: [String: [String: Any]]
        var files: [String: URL]    // entry name → extracted file
        var covers: [String: URL]
    }

    /// Reads `data.json` and extracts every `files/`/`covers/` payload into
    /// `tmp`. Throws before touching anything if the archive isn't ours.
    private nonisolated func stage(_ url: URL, into tmp: URL) async throws -> Staged {
        let fm = FileManager.default
        guard let archive = try? await Archive(url: url, accessMode: .read) else {
            throw BackupError.notAZip
        }
        guard let indexEntry = try? await archive.get("data.json") else { throw BackupError.missingIndex }
        var indexData = Data()
        _ = try await archive.extract(indexEntry, bufferSize: 64 * 1024) { indexData.append($0) }
        guard let index = try? JSONSerialization.jsonObject(with: indexData) as? [String: Any]
        else { throw BackupError.missingIndex }
        guard (index["app"] as? String) == "pageturner" else { throw BackupError.foreign }
        if let v = index["v"] as? Int, v > 1 { throw BackupError.futureVersion }
        guard let rawBooks = index["books"] as? [[String: Any]] else { throw BackupError.missingIndex }

        var staged = Staged(
            books: rawBooks,
            fileMeta: index["fileMeta"] as? [String: [String: Any]] ?? [:],
            files: [:], covers: [:]
        )
        for entry in try await archive.entries() where entry.type == .file {
            if entry.path.hasPrefix("files/") {
                let name = entry.path.replacingOccurrences(of: "files/", with: "")
                let decoded = name.removingPercentEncoding ?? name
                // zip-slip: a crafted "../" entry must not escape the staging dir
                guard !decoded.isEmpty, !decoded.contains("/"), !decoded.contains("..") else { continue }
                let out = tmp.appendingPathComponent(decoded)
                try? fm.removeItem(at: out)
                if (try? await archive.extract(entry, to: out)) != nil { staged.files[decoded] = out }
            } else if entry.path.hasPrefix("covers/") {
                let name = entry.path.replacingOccurrences(of: "covers/", with: "")
                guard !name.isEmpty, !name.contains("/"), !name.contains("..") else { continue }
                let out = tmp.appendingPathComponent(name)
                if (try? await archive.extract(entry, to: out)) != nil { staged.covers[name] = out }
            }
        }
        return staged
    }

    /// Native shape: `fileName`/`fileNames` map straight onto staged files.
    /// A book whose id is already in the library is skipped — restoring the
    /// same backup twice must not duplicate it.
    private func restoreNative(_ rec: [String: Any], staged: Staged) throws {
        guard let data = try? JSONSerialization.data(withJSONObject: rec),
              let book = try? JSONDecoder().decode(Book.self, from: data)
        else { throw BackupError.missingIndex }
        guard !library.books.contains(where: { $0.id == book.id }) else { return }

        let names = book.fileNames.isEmpty ? [book.fileName] : book.fileNames
        for name in names {
            guard let src = staged.files[name] else { throw BackupError.missingPayload }
            try fm.copyItem(at: src, to: booksDir.appendingPathComponent(name))
        }
        if let cover = staged.covers[book.id.uuidString]
            ?? staged.covers[book.id.uuidString + ".jpg"]
        {
            try? fm.copyItem(at: cover, to: library.coverURL(for: book))
        }
        library.addRestored(book)
    }

    /// Web shape: `fileKey`/`fileKeys` name `files/` entries; `fileMeta`
    /// carries the original filenames. Locators don't translate (web stores
    /// foliate CFIs), so position maps to the coarse `progress` fraction.
    private func restoreWeb(_ rec: [String: Any], staged: Staged) throws {
        var keys: [String] = []
        if let ks = rec["fileKeys"] as? [String] { keys = ks }
        else if let k = rec["fileKey"] as? String { keys = [k] }
        guard !keys.isEmpty else { throw BackupError.missingPayload }

        let id = UUID()
        var fileNames: [String] = []
        for (i, key) in keys.enumerated() {
            let decoded = key.removingPercentEncoding ?? key
            guard let src = staged.files[decoded] else { throw BackupError.missingPayload }
            let orig = staged.fileMeta[decoded]?["name"] as? String ?? decoded
            let ext = orig.split(separator: ".").last.map(String.init) ?? "bin"
            let name = "\(id.uuidString)-\(i).\(ext)"
            try fm.copyItem(at: src, to: booksDir.appendingPathComponent(name))
            fileNames.append(name)
        }

        var book = Book(
            id: id,
            title: rec["title"] as? String ?? "Imported book",
            author: rec["author"] as? String ?? "",
            fileName: fileNames[0],
            fileNames: fileNames,
            addedAt: Date()
        )
        // web stores progress as {fraction, positionSec}; accept a bare
        // number too in case an older export wrote one
        if let p = rec["progress"] as? [String: Any] {
            book.progression = p["fraction"] as? Double
            book.audioPosition = p["positionSec"] as? Double
        } else {
            book.progression = rec["progress"] as? Double
        }
        if book.progression == nil {
            book.progression = rec["progression"] as? Double
        }
        if let coverID = rec["id"] as? String,
           let cover = staged.covers[coverID] ?? staged.covers[coverID + ".jpg"]
        {
            try? fm.copyItem(at: cover, to: library.coverURL(for: book))
        }
        library.addRestored(book)
    }
}
