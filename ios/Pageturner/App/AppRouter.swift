import Observation

enum AppTab: Hashable {
    case library, together, stats, search
}

/// What is on screen above the tabs: the reader, the book sheets, settings.
/// One place decides, so a book opened from the library, search or a sheet
/// goes to the same destination.
@Observable
@MainActor
final class AppRouter {
    var reading: Book?
    var detail: Book?
    var editing: Book?
    var showSettings = false

    /// Open a book: an audiobook goes to the player (and keeps playing when it
    /// is dismissed); anything else opens in the reader.
    func open(_ book: Book, library: LibraryStore) {
        if book.isAudio {
            PlaybackCoordinator.shared.start(book, library: library)
        } else {
            reading = book
        }
    }
}
