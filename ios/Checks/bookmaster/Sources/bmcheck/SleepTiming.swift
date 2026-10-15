import Foundation

/// The sleep timer's arithmetic, free of AVFoundation so Linux can check it:
/// how far a media point is in wall seconds, and what a fired bell should do.
/// The players hold one timer rung once at the deadline — whatever can move
/// the deadline (a seek, the rate, a resume after a pause) re-aims the bell
/// instead of a poll every few seconds.
enum SleepTiming {
    /// Wall-clock seconds until `remainingMedia` has played at `rate` — at 2×
    /// the chapter ends in half the media time.
    static func wall(remainingMedia: TimeInterval, rate: Double) -> TimeInterval {
        max(0, remainingMedia) / max(rate, 0.1)
    }

    /// A bell that reached its deadline pauses playback — except chapter mode
    /// on a paused player: the boundary cannot drift nearer while the playhead
    /// is still, so the bell stays set for `play()` to re-aim. A minute-mode
    /// timer counts wall time, so it elapses even while paused.
    static func shouldPause(now: Date, deadline: Date, isPlaying: Bool, chapterMode: Bool) -> Bool {
        now >= deadline && (isPlaying || !chapterMode)
    }
}
