import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// Keeps the library in Spotlight — a book is one pull-down away — and tells Siri
/// the current titles. Titles, authors and covers go into the system's own
/// on-device index and nowhere else.
@MainActor
final class SpotlightIndexer {
    static let shared = SpotlightIndexer()
    static let enabledKey = "spotlight-enabled"

    private let defaults = UserDefaults.standard
    private let indexedKey = "spotlight-indexed"
    private var pending: Task<Void, Never>?
    private weak var library: LibraryStore?
    private var lastSignature: [String] = []

    private init() {}

    var enabled: Bool { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }

    /// A book was added, changed or removed — or just read a page, which is why
    /// this waits a few seconds and only does anything when a title, author or
    /// description actually differs.
    func libraryChanged(_ library: LibraryStore) {
        self.library = library
        pending?.cancel()
        pending = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.sync()
        }
    }

    /// The Settings switch.
    func setEnabled(_ on: Bool, library: LibraryStore) {
        defaults.set(on, forKey: Self.enabledKey)
        self.library = library
        lastSignature = []
        if on { sync() } else { removeAll() }
    }

    /// Bring the index in line with the library: new and changed books are
    /// (re)indexed, removed ones dropped.
    func sync() {
        guard let library else { return }
        let books = library.books
        let signature = books.map { "\($0.id.uuidString)|\($0.title)|\($0.author)|\($0.bookDescription ?? "")" }
        guard signature != lastSignature else { return }
        lastSignature = signature

        // Siri learns the titles it can be asked for
        PageturnerShortcuts.updateAppShortcutParameters()

        guard enabled else { return }
        let index = CSSearchableIndex.default()
        let current = Set(books.map { $0.id.uuidString })
        let gone = Set(defaults.stringArray(forKey: indexedKey) ?? []).subtracting(current)
        if !gone.isEmpty { index.deleteSearchableItems(withIdentifiers: Array(gone)) { _ in } }
        index.indexSearchableItems(books.map { item(for: $0, library: library) }) { _ in }
        defaults.set(Array(current), forKey: indexedKey)
    }

    private func removeAll() {
        CSSearchableIndex.default().deleteAllSearchableItems { _ in }
        defaults.removeObject(forKey: indexedKey)
    }

    private func item(for book: Book, library: LibraryStore) -> CSSearchableItem {
        let type: UTType = book.isAudio ? .audio : (book.ext == "pdf" ? .pdf : .epub)
        let attributes = CSSearchableItemAttributeSet(contentType: type)
        attributes.title = book.title
        attributes.displayName = book.title
        if !book.author.isEmpty { attributes.authorNames = [book.author] }
        let kind = book.isAudio ? "Audiobook" : "Book"
        if let blurb = book.bookDescription, !blurb.isEmpty {
            attributes.contentDescription = String(blurb.prefix(300))
        } else {
            attributes.contentDescription = book.author.isEmpty ? kind : "\(kind) by \(book.author)"
        }
        attributes.keywords = [book.title, book.author, kind.lowercased()].filter { !$0.isEmpty }
        let cover = library.coverURL(for: book)
        if FileManager.default.fileExists(atPath: cover.path) { attributes.thumbnailURL = cover }
        return CSSearchableItem(uniqueIdentifier: book.id.uuidString, domainIdentifier: "books", attributeSet: attributes)
    }
}
