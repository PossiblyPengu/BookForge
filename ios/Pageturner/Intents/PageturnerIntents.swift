import AppIntents
import Foundation

/// The books on disk, read straight from the catalogue. An intent can be asked
/// about books before the app's own store exists, so this doesn't depend on it.
enum LibrarySnapshot {
    static func load() -> [Book] {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        guard let data = try? Data(contentsOf: support.appendingPathComponent("library.json")),
              let books = try? JSONDecoder().decode([Book].self, from: data)
        else { return [] }
        return books
    }
}

/// A book, as Siri and Shortcuts see it.
struct BookEntity: AppEntity, Hashable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Book")
    static let defaultQuery = BookQuery()

    let id: UUID
    let title: String
    let author: String
    let isAudio: Bool

    init(_ book: Book) {
        id = book.id
        title = book.title
        author = book.author
        isAudio = book.isAudio
    }

    var displayRepresentation: DisplayRepresentation {
        let image = DisplayRepresentation.Image(systemName: isAudio ? "headphones" : "book.closed")
        if author.isEmpty {
            return DisplayRepresentation(title: "\(title)", image: image)
        }
        return DisplayRepresentation(title: "\(title)", subtitle: "\(author)", image: image)
    }
}

struct BookQuery: EntityStringQuery {
    func entities(for identifiers: [UUID]) async throws -> [BookEntity] {
        LibrarySnapshot.load().filter { identifiers.contains($0.id) }.map(BookEntity.init)
    }

    func entities(matching string: String) async throws -> [BookEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return try await suggestedEntities() }
        return LibrarySnapshot.load()
            .filter { $0.title.lowercased().contains(needle) || $0.author.lowercased().contains(needle) }
            .map(BookEntity.init)
    }

    /// What Siri offers before you say a title: what you were last in.
    func suggestedEntities() async throws -> [BookEntity] {
        LibrarySnapshot.load()
            .sorted { ($0.lastOpenedAt ?? $0.addedAt) > ($1.lastOpenedAt ?? $1.addedAt) }
            .prefix(10)
            .map(BookEntity.init)
    }
}

struct OpenBookIntent: AppIntent {
    static let title: LocalizedStringResource = "Open a Book"
    static let description = IntentDescription("Opens a book from your Pageturner library, to read or to listen to.")
    static let openAppWhenRun = true

    @Parameter(title: "Book")
    var book: BookEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentRouter.shared.request = .open(book.id)
        return .result()
    }
}

struct ContinueReadingIntent: AppIntent {
    static let title: LocalizedStringResource = "Continue Reading"
    static let description = IntentDescription("Picks up the book you were last in — reading, or listening for an audiobook.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentRouter.shared.request = .continueReading
        return .result()
    }
}

struct PageturnerShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ContinueReadingIntent(),
            phrases: [
                "Continue reading in \(.applicationName)",
                "Resume my book in \(.applicationName)",
                "Resume my audiobook in \(.applicationName)",
            ],
            shortTitle: "Continue Reading",
            systemImageName: "book.fill")
        AppShortcut(
            intent: OpenBookIntent(),
            phrases: ["Open \(\.$book) in \(.applicationName)"],
            shortTitle: "Open a Book",
            systemImageName: "books.vertical")
    }
}
