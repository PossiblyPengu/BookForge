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
    let id: UUID
    var title: String
    var author: String
    /// File name inside the Books folder.
    var fileName: String
    var addedAt: Date
    var lastOpenedAt: Date?
    /// Reading position, as a Readium `Locator` in JSON.
    var locatorJSON: String?
    /// 0…1 through the whole book.
    var progression: Double?
    var bookmarks: [Bookmark] = []
}

extension Book {
    /// Older library.json files predate `bookmarks` — decode leniently so the
    /// catalogue keeps loading instead of throwing on the missing key.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        author = try c.decode(String.self, forKey: .author)
        fileName = try c.decode(String.self, forKey: .fileName)
        addedAt = try c.decode(Date.self, forKey: .addedAt)
        lastOpenedAt = try c.decodeIfPresent(Date.self, forKey: .lastOpenedAt)
        locatorJSON = try c.decodeIfPresent(String.self, forKey: .locatorJSON)
        progression = try c.decodeIfPresent(Double.self, forKey: .progression)
        bookmarks = try c.decodeIfPresent([Bookmark].self, forKey: .bookmarks) ?? []
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
    func coverURL(for book: Book) -> URL { coversDir.appendingPathComponent(book.id.uuidString + ".jpg") }

    func cover(for book: Book) -> UIImage? {
        UIImage(contentsOfFile: coverURL(for: book).path)
    }

    // MARK: - Import

    func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var failures: [String] = []
        for url in urls {
            do { try await importFile(url) } catch {
                failures.append("\(url.lastPathComponent): \(error.localizedDescription)")
            }
        }
        if !failures.isEmpty { lastError = failures.joined(separator: "\n") }
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
        try? fm.removeItem(at: fileURL(for: book))
        try? fm.removeItem(at: coverURL(for: book))
        books.removeAll { $0.id == book.id }
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
