import AVFoundation
import Foundation
import ReadiumShared
import ReadiumZIPFoundation
import SwiftUI
import UIKit

struct Bookmark: Identifiable, Codable, Hashable {
    let id: UUID
    /// Chapter/excerpt shown in the list.
    var title: String
    /// Position, as a Readium `Locator` in JSON.
    var locatorJSON: String
    /// 0…1 through the whole book when saved.
    var progression: Double?
    var createdAt: Date

    init(id: UUID = UUID(), title: String, locatorJSON: String, progression: Double?, createdAt: Date = Date()) {
        self.id = id
        self.title = title
        self.locatorJSON = locatorJSON
        self.progression = progression
        self.createdAt = createdAt
    }
}

struct Book: Identifiable, Codable, Hashable {
    /// Extensions AVPlayer handles directly (m4b/m4a are MPEG-4 audio).
    static let audioExtensions: Set<String> = [
        "m4b", "m4a", "mp3", "aac", "wav", "flac", "ogg", "oga", "opus", "caf",
    ]

    let id: UUID
    var title: String
    var author: String
    /// File name inside the Books folder — the first track for audiobooks.
    var fileName: String
    /// All tracks, in play order. Equals `[fileName]` for single-file books.
    var fileNames: [String] = []
    /// Original track display names (audiobooks import as `<id>-<n>.<ext>`,
    /// so the source basenames are kept here for the chapter picker).
    var trackTitles: [String] = []
    var addedAt: Date
    var lastOpenedAt: Date?
    /// Reading position, as a Readium `Locator` in JSON.
    var locatorJSON: String?
    /// Audiobook position in seconds from the start of the first track.
    var audioPosition: TimeInterval?
    /// 0…1 through the whole book.
    var progression: Double?
    var bookmarks: [Bookmark] = []
    var highlights: [Highlight] = []
    /// The BookMaster shelf row this book is pinned to, once a push has made one.
    var bookmasterId: String?
    /// What BookMaster's shelf says about this book (status, rating, how far
    /// it thinks you are, whether it is queued up next) — display only.
    var bmStatus: String?
    var bmRating: Int?
    var bmRemotePercent: Double?
    var bmUpNext: Bool?
    /// A blurb for the detail page — from the EPUB's own metadata or an online lookup.
    var bookDescription: String?
    var year: String?
    var isbn: String?
    /// Open Library work id ("OL45804W") — what BookMaster keeps on its catalogue rows.
    var openLibraryId: String?
    /// Names of the shelves this book is on.
    var collections: [String] = []
    /// When the "pick up where BookMaster has you" offer was last declined for this book.
    var resumeDismissedAt: Date?

    var ext: String { fileName.split(separator: ".").last.map(String.init)?.lowercased() ?? "" }
    var isAudio: Bool { Self.audioExtensions.contains(ext) }
}

struct Highlight: Identifiable, Codable, Hashable {
    let id: UUID
    /// Position + selected text, as a Readium `Locator` in JSON.
    var locatorJSON: String
    /// The selected text, shown in the list.
    var text: String
    var createdAt: Date

    init(id: UUID = UUID(), locatorJSON: String, text: String, createdAt: Date = Date()) {
        self.id = id
        self.locatorJSON = locatorJSON
        self.text = text
        self.createdAt = createdAt
    }
}

extension Book {
    /// Older library.json files predate `bookmarks`/`fileNames`/`audioPosition`
    /// — decode leniently so the catalogue keeps loading on the missing keys.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        author = try c.decode(String.self, forKey: .author)
        fileName = try c.decode(String.self, forKey: .fileName)
        // backups interoperate with the web build, which stores ms-since-1970
        // — seconds now ≈ 1.7e9, ms ≈ 1.7e12, so 1e11 cleanly separates them
        func date(_ key: CodingKeys) -> Date? {
            guard let raw = try? c.decodeIfPresent(Double.self, forKey: key) else { return nil }
            if raw > 1e11 { return Date(timeIntervalSince1970: raw / 1000) }
            // 2000-01-01 in 1970-based seconds. Earlier builds wrote dates as
            // seconds since 2001 (JSONEncoder's default) and read them back as
            // since 1970 — each save then moved them back 31 years. Anything
            // under this can't be a real 1970-based date, so read it as 2001-based.
            if raw >= 946_684_800 { return Date(timeIntervalSince1970: raw) }
            if raw > 0 { return Date(timeIntervalSinceReferenceDate: raw) }
            return nil   // drifted past repair
        }
        addedAt = date(.addedAt) ?? Date()
        lastOpenedAt = date(.lastOpenedAt)
        locatorJSON = try c.decodeIfPresent(String.self, forKey: .locatorJSON)
        audioPosition = try c.decodeIfPresent(TimeInterval.self, forKey: .audioPosition)
        progression = try c.decodeIfPresent(Double.self, forKey: .progression)
        bookmarks = try c.decodeIfPresent([Bookmark].self, forKey: .bookmarks) ?? []
        highlights = try c.decodeIfPresent([Highlight].self, forKey: .highlights) ?? []
        fileNames = try c.decodeIfPresent([String].self, forKey: .fileNames) ?? [fileName]
        trackTitles = try c.decodeIfPresent([String].self, forKey: .trackTitles) ?? []
        bookmasterId = try c.decodeIfPresent(String.self, forKey: .bookmasterId)
        bmStatus = try c.decodeIfPresent(String.self, forKey: .bmStatus)
        bmRating = try c.decodeIfPresent(Int.self, forKey: .bmRating)
        bmRemotePercent = try c.decodeIfPresent(Double.self, forKey: .bmRemotePercent)
        bmUpNext = try c.decodeIfPresent(Bool.self, forKey: .bmUpNext)
        bookDescription = try c.decodeIfPresent(String.self, forKey: .bookDescription)
        year = try c.decodeIfPresent(String.self, forKey: .year)
        isbn = try c.decodeIfPresent(String.self, forKey: .isbn)
        openLibraryId = try c.decodeIfPresent(String.self, forKey: .openLibraryId)
        collections = try c.decodeIfPresent([String].self, forKey: .collections) ?? []
        resumeDismissedAt = date(.resumeDismissedAt)
    }

    /// How a BookMaster push names this book.
    var bookMasterRef: BMBookRef {
        BMBookRef(title: title, author: sendableAuthor(author), isbn: isbn,
                  openLibraryId: openLibraryId, userBookId: bookmasterId)
    }
}

/// The library: book files in Documents/Books (visible in the Files app),
/// covers and the catalogue in Application Support.
@MainActor
final class LibraryStore: ObservableObject {
    @Published private(set) var books: [Book] = []
    /// Shelves (the web app's "collections") in the order they were made.
    @Published private(set) var shelves: [String] = UserDefaults.standard.stringArray(forKey: "shelves") ?? []
    @Published var importing = false
    @Published var lastError: String?

    private let fm = FileManager.default
    private let booksDir: URL
    private let coversDir: URL
    private let catalogueURL: URL

    init() {
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        booksDir = docs.appendingPathComponent("Books", isDirectory: true)
        coversDir = support.appendingPathComponent("Covers", isDirectory: true)
        catalogueURL = support.appendingPathComponent("library.json")
        try? fm.createDirectory(at: booksDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: coversDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: catalogueURL),
           let list = try? JSONDecoder().decode([Book].self, from: data)
        {
            books = list
        }
    }

    func fileURL(for book: Book) -> URL { booksDir.appendingPathComponent(book.fileName) }
    func fileURLs(for book: Book) -> [URL] {
        let names = book.fileNames.isEmpty ? [book.fileName] : book.fileNames
        return names.map { booksDir.appendingPathComponent($0) }
    }
    func coverURL(for book: Book) -> URL { coversDir.appendingPathComponent(book.id.uuidString + ".jpg") }

    func cover(for book: Book) -> UIImage? {
        UIImage(contentsOfFile: coverURL(for: book).path)
    }

    // MARK: - Import

    /// Audio files from one folder become one audiobook (natural-sorted so
    /// "ch2" comes before "ch10"); different folders become separate books.
    /// Ebooks import one per file.
    enum ImportError: LocalizedError {
        case notAnArchive, looksLikeBackup, nothingToImport, emptyText

        var errorDescription: String? {
            switch self {
            case .notAnArchive: return "That zip file couldn’t be opened."
            case .looksLikeBackup: return "That looks like a Pageturner backup — restore it from Settings → Restore Backup."
            case .nothingToImport: return "There were no books, comics or audio files inside."
            case .emptyText: return "There was no text in that file."
            }
        }
    }

    /// What a zip may carry. HTML and text are left out on purpose: a zip of a
    /// website or a folder of notes shouldn't become hundreds of "books".
    private static let archiveExtensions = Set(["epub", "pdf", "cbz"]).union(Book.audioExtensions)

    func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var failures: [String] = []
        await importBatch(urls, failures: &failures, inArchive: false)
        if !failures.isEmpty { lastError = failures.joined(separator: "\n") }
    }

    private func importBatch(_ urls: [URL], failures: inout [String], inArchive: Bool) async {
        var audio: [URL] = []
        for url in urls {
            let ext = url.pathExtension.lowercased()
            if Book.audioExtensions.contains(ext) {
                audio.append(url)
            } else if ext == "zip", !inArchive {
                do { try await importArchive(url, failures: &failures) } catch {
                    failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
                }
            } else if let format = TextBook.format(forExtension: ext) {
                do { try await importTextBook(url, format: format) } catch {
                    failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
                }
            } else {
                do { try await importFile(url) } catch {
                    failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
                }
            }
        }
        // group audio by containing folder — a multi-album selection must
        // not collapse into one book
        let groups = Dictionary(grouping: audio) { $0.deletingLastPathComponent().path }
        for dir in groups.keys.sorted() {
            do { try await importAudiobook(groups[dir] ?? []) } catch {
                failures.append("\(groups[dir]?.count ?? 0) audio files: \(error.localizedDescription)")
            }
        }
    }

    /// A zip of books — a folder of audiobook parts, a pile of EPUBs — unpacked
    /// and imported. Folders inside it stay folders, so each audiobook directory
    /// becomes one book.
    private func importArchive(_ source: URL, failures: inout [String]) async throws {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        guard let archive = try? await Archive(url: source, accessMode: .read) else {
            throw ImportError.notAnArchive
        }
        let tmp = fm.temporaryDirectory.appendingPathComponent("unzip-\(UUID().uuidString)")
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tmp) }

        var extracted: [URL] = []
        let root = tmp.standardizedFileURL.path + "/"
        for entry in try await archive.entries() where entry.type == .file {
            let path = entry.path
            if path == "data.json" { throw ImportError.looksLikeBackup }
            let name = (path as NSString).lastPathComponent
            let ext = (name as NSString).pathExtension.lowercased()
            guard Self.archiveExtensions.contains(ext), !name.hasPrefix("."), !path.hasPrefix("__MACOSX/") else { continue }
            // zip-slip: a crafted "../" entry must not escape the staging folder
            let out = tmp.appendingPathComponent(path)
            guard out.standardizedFileURL.path.hasPrefix(root) else { continue }
            try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? await archive.extract(entry, to: out)) != nil { extracted.append(out) }
        }
        guard !extracted.isEmpty else { throw ImportError.nothingToImport }
        await importBatch(extracted, failures: &failures, inArchive: true)
    }

    /// Plain text, Markdown or HTML: rebuilt as an EPUB (chapters found, text
    /// un-wrapped) so it reads like any other book, then imported as one.
    private func importTextBook(_ source: URL, format: TextBook.Format) async throws {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        let data = try Data(contentsOf: source)
        let fallback = source.deletingPathExtension().lastPathComponent
        // a long book takes a moment — keep it off the main actor
        let converted = await Task.detached(priority: .userInitiated) {
            TextBook.convert(data, format: format, fallbackTitle: fallback)
        }.value
        guard let converted else { throw ImportError.emptyText }

        let id = UUID()
        let fileName = "\(id.uuidString).epub"
        try converted.epub.write(to: booksDir.appendingPathComponent(fileName), options: .atomic)
        try await register(id: id, fileName: fileName, fallbackTitle: converted.title)
    }

    private func importAudiobook(_ sources: [URL]) async throws {
        let sorted = sources.sorted {
            $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending
        }
        let id = UUID()
        var fileNames: [String] = []
        do {
            for source in sorted {
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let ext = source.pathExtension.lowercased()
                let fileName = ext.isEmpty ? id.uuidString : "\(id.uuidString)-\(fileNames.count).\(ext)"
                try fm.copyItem(at: source, to: booksDir.appendingPathComponent(fileName))
                fileNames.append(fileName)
            }
        } catch {
            // a partial copy would orphan files nobody references
            for name in fileNames {
                try? fm.removeItem(at: booksDir.appendingPathComponent(name))
            }
            throw error
        }

        var book = Book(
            id: id,
            title: sorted[0].deletingPathExtension().lastPathComponent,
            author: "",
            fileName: fileNames[0],
            fileNames: fileNames,
            addedAt: Date()
        )
        book.trackTitles = sorted.map { $0.deletingPathExtension().lastPathComponent }
        // Title priority: album metadata → shared folder name → track title →
        // filename. Track-1 title is often a chapter name ("Chapter 1"), which
        // is worse than the folder the files came from.
        let asset = AVURLAsset(url: fileURL(for: book))
        let metadata = (try? await asset.load(.metadata)) ?? []
        func meta(_ key: AVMetadataKey) -> AVMetadataItem? {
            metadata.first { $0.commonKey == key }
        }
        let dirs = Set(sorted.map { $0.deletingLastPathComponent().path })
        let dir = sorted[0].deletingLastPathComponent().lastPathComponent
        let dirTitle = dirs.count == 1 && !dir.isEmpty && dir != "Inbox" && dir != "Documents" ? dir : nil
        if let album = meta(.commonKeyAlbumName)?.stringValue, !album.isEmpty {
            book.title = album
        } else if let dirTitle {
            book.title = dirTitle
        } else if let name = meta(.commonKeyTitle)?.stringValue, !name.isEmpty {
            book.title = name
        }
        if let name = meta(.commonKeyArtist)?.stringValue {
            book.author = name
        }
        if let data = meta(.commonKeyArtwork)?.dataValue,
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.85)
        {
            try? jpeg.write(to: coverURL(for: book))
        }
        books.insert(book, at: 0)
        save()
    }

    private func importFile(_ source: URL) async throws {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        let id = UUID()
        let ext = source.pathExtension.lowercased()
        let fileName = ext.isEmpty ? id.uuidString : "\(id.uuidString).\(ext)"
        try fm.copyItem(at: source, to: booksDir.appendingPathComponent(fileName))
        try await register(id: id, fileName: fileName, fallbackTitle: source.deletingPathExtension().lastPathComponent)
    }

    /// Open a copied file with Readium for its title, author and cover, and put
    /// it on the shelf. A file Readium can't open is removed again.
    private func register(id: UUID, fileName: String, fallbackTitle: String) async throws {
        let dest = booksDir.appendingPathComponent(fileName)
        var book = Book(
            id: id,
            title: fallbackTitle,
            author: "",
            fileName: fileName,
            fileNames: [fileName],
            addedAt: Date()
        )
        do {
            let publication = try await Readium.shared.open(url: dest)
            if let title = publication.metadata.title, !title.isEmpty { book.title = title }
            // " & ", not ", ": a comma reads as "Last, First" to BookMaster
            book.author = publication.metadata.authors.map(\.name).joined(separator: " & ")
            if let blurb = publication.metadata.description, !blurb.isEmpty {
                let text = BookText.plain(fromHTML: blurb)
                if !text.isEmpty { book.bookDescription = text }
            }
            if let published = publication.metadata.published {
                // UTC: a date at midnight UTC must not read as the previous year in the Americas
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
                book.year = String(calendar.component(.year, from: published))
            }
            if let identifier = publication.metadata.identifier, let isbn = ISBN.normalize(identifier) {
                book.isbn = isbn
            }
            if let image = try? await publication.cover().get(),
               let jpeg = image.jpegData(compressionQuality: 0.85)
            {
                try? jpeg.write(to: coverURL(for: book))
            }
        } catch {
            try? fm.removeItem(at: dest)
            throw error
        }
        books.insert(book, at: 0)
        save()
    }

    // MARK: - Changes

    /// Save a book the reader or player changed. Those hold their own copy of
    /// the book, so the BookMaster fields — which only a push reply or a shelf
    /// pull may change — are always kept from the stored one; writing back a
    /// stale copy must not undo them. Use `updateBookMaster` to change them.
    func update(_ book: Book) {
        guard let i = books.firstIndex(where: { $0.id == book.id }) else { return }
        var incoming = book
        incoming.bookmasterId = books[i].bookmasterId
        incoming.bmStatus = books[i].bmStatus
        incoming.bmRating = books[i].bmRating
        incoming.bmRemotePercent = books[i].bmRemotePercent
        incoming.bmUpNext = books[i].bmUpNext
        books[i] = incoming
        save()
    }

    /// The answer to "BookMaster has you at N% — jump there?": take its place
    /// (`fraction`) or, with nil, stay where this device is.
    func answerResume(_ id: UUID, fraction: Double?) {
        guard let i = books.firstIndex(where: { $0.id == id }) else { return }
        var book = books[i]
        if let fraction { ResumeOffer.accept(&book, fraction: fraction) } else { ResumeOffer.decline(&book) }
        update(book)
    }

    /// Change only the BookMaster fields of one book.
    func updateBookMaster(_ id: UUID, _ change: (inout Book) -> Void) {
        guard let i = books.firstIndex(where: { $0.id == id }) else { return }
        var book = books[i]
        change(&book)
        guard book != books[i] else { return }
        books[i] = book
        save()
    }

    /// Apply a whole shelf pull in one write.
    func applyShelf(_ changes: [(UUID, (inout Book) -> Void)]) {
        var changed = false
        for (id, change) in changes {
            guard let i = books.firstIndex(where: { $0.id == id }) else { continue }
            var book = books[i]
            change(&book)
            if book != books[i] { books[i] = book; changed = true }
        }
        if changed { save() }
    }

    // MARK: - Shelves

    private func saveShelves() { UserDefaults.standard.set(shelves, forKey: "shelves") }

    /// Make a shelf; returns its name as stored, or the existing one when the
    /// name is taken (case-insensitively). Blank names are refused.
    @discardableResult
    func addShelf(_ raw: String) -> String? {
        // "~" marks the built-in filters ("All", "Up next") in the library's chip row
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).drop(while: { $0 == "~" })
        let clean = String(name).trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty, clean.count <= 40 else { return nil }
        if let existing = shelves.first(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) { return existing }
        shelves.append(clean)
        saveShelves()
        return clean
    }

    func renameShelf(_ old: String, to raw: String) {
        let new = raw.trimmingCharacters(in: .whitespaces)
        guard let i = shelves.firstIndex(of: old), !new.isEmpty, new.count <= 40, !new.hasPrefix("~"),
              !shelves.contains(where: { $0 != old && $0.caseInsensitiveCompare(new) == .orderedSame })
        else { return }
        shelves[i] = new
        for j in books.indices {
            books[j].collections = books[j].collections.map { $0 == old ? new : $0 }
        }
        saveShelves()
        save()
    }

    func deleteShelf(_ name: String) {
        shelves.removeAll { $0 == name }
        for j in books.indices { books[j].collections.removeAll { $0 == name } }
        saveShelves()
        save()
    }

    /// Put books on a shelf, or take them off it.
    func setShelf(_ name: String, on ids: [UUID], member: Bool) {
        let wanted = Set(ids)
        for j in books.indices where wanted.contains(books[j].id) {
            let has = books[j].collections.contains(name)
            if member, !has { books[j].collections.append(name) }
            if !member, has { books[j].collections.removeAll { $0 == name } }
        }
        save()
    }

    enum ShelfState { case none, some, all }

    func state(of name: String, among ids: [UUID]) -> ShelfState {
        let wanted = Set(ids)
        let mine = books.filter { wanted.contains($0.id) }
        let on = mine.filter { $0.collections.contains(name) }.count
        if on == 0 { return .none }
        return on == mine.count ? .all : .some
    }

    /// A cover file changed on disk — views read covers by path, so nudge them to look again.
    func coverChanged() { objectWillChange.send() }

    /// Finished: it leaves the Continue card and BookMaster shelves it as read.
    /// The position is left alone, so reopening still lands where they stopped.
    func markFinished(_ id: UUID) {
        guard let i = books.firstIndex(where: { $0.id == id }) else { return }
        books[i].progression = 1
        save()
        let book = books[i]
        Task {
            await BookMaster.shared.syncProgress(
                bookKey: book.title, ref: book.bookMasterRef, percent: 1,
                isAudio: book.isAudio, force: true,
                pinned: { [weak self] pin in self?.updateBookMaster(id) { $0.bookmasterId = pin } })
        }
    }

    /// Back to the start — for a re-read, or one abandoned part way.
    func restart(_ id: UUID) {
        guard let i = books.firstIndex(where: { $0.id == id }) else { return }
        books[i].progression = 0
        books[i].locatorJSON = nil
        books[i].audioPosition = nil
        books[i].lastOpenedAt = nil
        save()
    }

    /// Forget every BookMaster tie — after unlinking, or on a restored library.
    func clearBookMasterFields() {
        for i in books.indices {
            books[i].bookmasterId = nil
            books[i].bmStatus = nil
            books[i].bmRating = nil
            books[i].bmRemotePercent = nil
            books[i].bmUpNext = nil
        }
        save()
    }

    func delete(_ book: Book) {
        for url in fileURLs(for: book) { try? fm.removeItem(at: url) }
        try? fm.removeItem(at: coverURL(for: book))
        books.removeAll { $0.id == book.id }
        save()
    }

    /// Inserts a book brought back by backup restore (files already copied).
    func addRestored(_ book: Book) {
        for name in book.collections where !shelves.contains(name) { shelves.append(name) }
        saveShelves()
        books.insert(book, at: 0)
        save()
    }

    enum SortOrder: String, CaseIterable, Identifiable {
        case recent, added, title, author
        var id: String { rawValue }
        var label: String {
            switch self {
            case .recent: return "Recently Opened"
            case .added: return "Recently Added"
            case .title: return "Title"
            case .author: return "Author"
            }
        }
    }

    /// Filtered + sorted view of the catalogue for the library screen.
    func sortedBooks(order: SortOrder, query: String) -> [Book] {
        var list = books
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty {
            list = list.filter {
                $0.title.localizedCaseInsensitiveContains(q)
                    || $0.author.localizedCaseInsensitiveContains(q)
            }
        }
        switch order {
        case .recent:
            return list.sorted { ($0.lastOpenedAt ?? $0.addedAt) > ($1.lastOpenedAt ?? $1.addedAt) }
        case .added:
            return list.sorted { $0.addedAt > $1.addedAt }
        case .title:
            return list.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .author:
            return list.sorted { $0.author.localizedCaseInsensitiveCompare($1.author) == .orderedAscending }
        }
    }

    // MARK: - Persistence

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(books) else { return }
        try? data.write(to: catalogueURL, options: .atomic)
    }
}
