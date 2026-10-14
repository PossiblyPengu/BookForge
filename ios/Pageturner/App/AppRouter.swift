import Foundation
import Observation

enum AppTab: Hashable {
    case reading, library, together, search
}

/// BookMaster has a book further on than this device — asked before it opens.
struct ResumePrompt: Identifiable {
    let id = UUID()
    let book: Book
    /// BookMaster's place, 0…1.
    let fraction: Double
}

/// What is on screen above the tabs: the book sheets and settings — and which
/// tab is up, since the Reading tab is itself the reader and the player. One
/// place decides, so a book opened from the library, search or a sheet goes to
/// the same destination.
@Observable
@MainActor
final class AppRouter {
    /// The selected tab. Opening a book lands on Reading, where the book is.
    var tab: AppTab = .library
    /// The book open in the Reading tab — nil when the tab shows its browse list.
    var reading: Book?
    var detail: Book?
    var editing: Book?
    var showSettings = false
    /// BookMaster's sign-in sheet (the Together and Stats prompts open it directly).
    var showLink = false
    /// Books waiting on "Remove from Library?" — removing deletes their files.
    var pendingDelete: [Book] = []
    var shelfTarget: ShelfTarget?
    var resumePrompt: ResumePrompt?

    func openShelves(_ ids: [UUID]) { shelfTarget = ShelfTarget(bookIDs: ids) }

    func askDelete(_ books: [Book]) { pendingDelete = books }

    /// Open a book: an audiobook goes to the player (and keeps playing when it
    /// is left); anything else opens in the reader. Either way the Reading tab
    /// is where the book is. When BookMaster has the book further on than this
    /// device, that is asked about first.
    func open(_ book: Book, library: LibraryStore) {
        if AppPrefs.resumeAsk, let fraction = ResumeOffer.target(for: book) {
            resumePrompt = ResumePrompt(book: book, fraction: fraction)
            return
        }
        launch(book, library: library)
    }

    /// The answer to the resume prompt: jump to BookMaster's place or stay put —
    /// either way the book then opens.
    func answer(_ prompt: ResumePrompt, jump: Bool, library: LibraryStore) {
        resumePrompt = nil
        library.answerResume(prompt.book.id, fraction: jump ? prompt.fraction : nil)
        launch(library.books.first { $0.id == prompt.book.id } ?? prompt.book, library: library)
    }

    /// Leaving an open book: back to the library, with the position kept so the
    /// Reading tab's list can offer it again.
    func leaveReading() {
        reading = nil
        tab = .library
    }

    private func launch(_ book: Book, library: LibraryStore) {
        if book.isAudio {
            PlaybackCoordinator.shared.start(book, library: library)
        } else {
            reading = book
        }
        tab = .reading
    }
}
