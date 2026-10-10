import Foundation

/// One audible thing at a time.
///
/// Read-aloud and the audiobook player are separate engines that share one audio
/// session, so nothing stopped them playing over each other. Whichever starts
/// claims focus and the other is paused — not stopped, so it can be resumed.
@MainActor
final class AudioFocus {
    static let shared = AudioFocus()

    private var owners: [String: () -> Void] = [:]

    private init() {}

    /// Register something that makes sound, and how to quieten it.
    func register(_ id: String, pause: @escaping () -> Void) {
        owners[id] = pause
    }

    func unregister(_ id: String) {
        owners[id] = nil
    }

    /// `id` is about to make sound: pause everything else.
    func claim(_ id: String) {
        for (other, pause) in owners where other != id { pause() }
    }
}
