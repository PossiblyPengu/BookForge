import Foundation

/// Where the voice is in what has been queued for it, counted in frames of audio at the voice's own
/// pace. The player cannot be asked how far a buffer has played, so this is kept by the clock — moved on
/// as time passes — and corrected each time a piece of audio is reported heard. Pure logic, so it is
/// checked off-device (ios/Checks/bookmaster).
struct PlayheadClock {
    /// Everything queued since nothing was left to play, and how much of it has been heard in full.
    private(set) var queued: Double = 0
    private(set) var heard: Double = 0
    /// How far into the piece being heard it is.
    private(set) var into: Double = 0

    /// A sentence of `frames` is queued behind what is there. Returns where it starts.
    mutating func queue(frames: Double) -> Double {
        let start = queued
        queued += frames
        return start
    }

    /// `seconds` of real time passed while a piece of `pieceFrames` was playing, `speed` times as
    /// fast as the voice's own pace.
    mutating func advance(seconds: Double, speed: Double, sampleRate: Double, pieceFrames: Double) {
        guard seconds > 0, speed > 0, sampleRate > 0 else { return }
        into = min(into + seconds * speed * sampleRate, max(pieceFrames, 0))
    }

    /// The piece of `frames` has been heard in full, and the next one starts now.
    mutating func finishedPiece(frames: Double) {
        heard += frames
        into = 0
    }

    /// The piece that was playing starts again from its beginning (after an interruption).
    mutating func restartPiece() {
        into = 0
    }

    /// Nothing is queued any more: start counting from nothing.
    mutating func reset() {
        queued = 0
        heard = 0
        into = 0
    }

    /// Seconds into the sentence that was queued at `start` and is `frames` long — never before its
    /// beginning or past its end.
    func seconds(sentenceStart start: Double, frames: Double, sampleRate: Double) -> TimeInterval {
        guard sampleRate > 0 else { return 0 }
        return min(max(heard + into - start, 0), max(frames, 0)) / sampleRate
    }

    /// Frames still to play of `pending` (the frames of every piece not yet heard).
    func framesLeft(pending: Double) -> Double {
        max(pending - into, 0)
    }
}
