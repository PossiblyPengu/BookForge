import Foundation
import Observation

/// Owns the one audiobook that is playing, so it keeps playing when the
/// player screen is dismissed and the mini player can show it anywhere.
@Observable
@MainActor
final class PlaybackCoordinator {
    static let shared = PlaybackCoordinator()

    private(set) var player: AudioPlayer?
    private(set) var bookID: UUID?
    /// Whether the Now Playing sheet is up.
    var showNowPlaying = false

    var isActive: Bool { player != nil }

    private init() {}

    /// Open a book's audio. Choosing the book that is already loaded just
    /// brings its player back up instead of restarting it.
    func start(_ book: Book, library: LibraryStore) {
        if bookID == book.id, player != nil {
            showNowPlaying = true
            return
        }
        stop()
        let next = AudioPlayer(book: book, library: library)
        player = next
        bookID = book.id
        showNowPlaying = true
        Task { await next.open() }
    }

    /// Stop playback, save the position and drop the player.
    func stop() {
        player?.close()
        player = nil
        bookID = nil
        showNowPlaying = false
    }
}
