import Foundation
import Observation

/// The reading timer, kept app-wide: start it for a book, put the phone down,
/// come back — the stopwatch is still running (the start time is stored, so
/// even a relaunch keeps it). Stopping hands its minutes to the log sheet.
@Observable
@MainActor
final class BMReadingTimer {
    static let shared = BMReadingTimer()

    /// What is being timed — a shelf pin and its name, so the chip can say so.
    struct Run: Codable, Equatable {
        var pin: String
        var title: String
        var startedAt: Date
    }

    private(set) var run: Run?

    private let key = "bm-reading-timer"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: key),
           let run = try? JSONDecoder().decode(Run.self, from: data) {
            self.run = run
        }
    }

    var running: Bool { run != nil }

    /// Seconds on the clock — callers tick themselves for the live read.
    var elapsed: TimeInterval { run.map { Date().timeIntervalSince($0.startedAt) } ?? 0 }

    /// Start timing a shelf row. Timing another book takes over — one clock.
    func start(pin: String, title: String) {
        run = Run(pin: pin, title: title, startedAt: Date())
        persist()
    }

    /// Stop and answer the whole minutes — a 4m50s sit counts as five.
    @discardableResult
    func stop() -> Int {
        let minutes = Int((elapsed / 60).rounded(.up))
        run = nil
        defaults.removeObject(forKey: key)
        return minutes
    }

    /// Forget it without logging — a mistap, not a sitting.
    func cancel() {
        run = nil
        defaults.removeObject(forKey: key)
    }

    private func persist() {
        if let run, let data = try? JSONEncoder().encode(run) {
            defaults.set(data, forKey: key)
        }
    }
}
