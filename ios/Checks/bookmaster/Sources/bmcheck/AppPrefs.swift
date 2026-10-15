import Foundation

/// The switches the settings form offers, read where they act rather than where
/// they are shown. Every key has its default here, so a fresh install and an
/// upgrade behave the same until the switch is touched. Foundation only, so the
/// Linux checks can exercise them.
enum AppPrefs {
    private static var defaults: UserDefaults { .standard }

    /// App-wide appearance: "system", "light" or "dark".
    static var appearance: String { defaults.string(forKey: "app-appearance") ?? "system" }

    /// The audiobook skip buttons and the lock screen's, in seconds.
    static var skipBack: Double { positive("audio-skip-back", fallback: 15) }
    static var skipForward: Double { positive("audio-skip-fwd", fallback: 30) }

    /// Whether presence beats name the screen ("bookmaster", "reader"…). Off
    /// still says online, just not where.
    static var sharePlace: Bool { enabled("bm-share-place") }

    /// Whether opening a book may ask to jump to BookMaster's place. Off never
    /// asks and never jumps — this device keeps its own place.
    static var resumeAsk: Bool { enabled("bm-resume-ask") }

    /// Whether BookMaster gets this device's cover art with the books.
    static var sendCovers: Bool { enabled("bm-covers") }

    /// The waiting-suggestions count on the BookMaster tab.
    static var showBadge: Bool { enabled("bm-badge") }

    /// Whether this phone keeps its own reading time (the Stats page, "time
    /// left" estimates). BookMaster's own numbers are unaffected.
    static var statsTracking: Bool { enabled("stats-tracking") }

    private static func enabled(_ key: String) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }

    private static func positive(_ key: String, fallback: Double) -> Double {
        let v = defaults.double(forKey: key)
        return v > 0 ? v : fallback
    }
}
