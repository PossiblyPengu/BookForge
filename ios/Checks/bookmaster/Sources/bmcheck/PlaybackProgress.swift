import Foundation

struct PlaybackProgress {
    private var written: (position: TimeInterval?, progression: Double?)?
    private var finishedAt: TimeInterval?

    mutating func adopt(position: TimeInterval?, progression: Double?, playhead: TimeInterval) -> Bool {
        guard position != written?.position || progression != written?.progression else { return false }
        written = (position, progression)
        finishedAt = (progression ?? 0) >= 0.995 ? playhead : nil
        return true
    }

    func maySave(at position: TimeInterval) -> Bool {
        finishedAt.map { abs(position - $0) > 0.001 } ?? true
    }

    mutating func saved(position: TimeInterval, progression: Double) {
        written = (position, progression)
        finishedAt = nil
    }
}
