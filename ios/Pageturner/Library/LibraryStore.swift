import AVFoundation
import Foundation
import ReadiumShared
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
            return Date(timeIntervalSince1970: raw > 1e11 ? raw / 1000 : raw)
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
    }
}

/// The library: book files in Documents/Books (visible in the Files app),
/// covers and the catalogue in Application Support.
@MainActor
final class LibraryStore: ObservableObject {
    @Published private(set) var books: [Book] = []
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
    func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var failures: [String] = []
        var audio: [URL] = []
        for url in urls {
            if Book.audioExtensions.contains(url.pathExtension.lowercased()) {
                audio.append(url)
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
        if !failures.isEmpty { lastError = failures.joined(separator: "\n") }
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
        let dest = booksDir.appendingPathComponent(fileName)
        try fm.copyItem(at: source, to: dest)

        var book = Book(
            id: id,
            title: source.deletingPathExtension().lastPathComponent,
            author: "",
            fileName: fileName,
            fileNames: [fileName],
            addedAt: Date()
        )
        do {
            let publication = try await Readium.shared.open(url: dest)
            if let title = publication.metadata.title, !title.isEmpty { book.title = title }
            book.author = publication.metadata.authors.map(\.name).joined(separator: ", ")
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

    func update(_ book: Book) {
        guard let i = books.firstIndex(where: { $0.id == book.id }) else { return }
        books[i] = book
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
        guard let data = try? JSONEncoder().encode(books) else { return }
        try? data.write(to: catalogueURL, options: .atomic)
    }
}
