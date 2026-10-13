import Foundation

/// "BookMaster has you further on" — when to offer the jump, and what taking it
/// (or turning it down) does to a book. Pure logic over `Book`, so the rules can
/// be checked off-device.
enum ResumeOffer {
    /// Percentage points BookMaster must be ahead by before it is worth asking.
    static let margin = 2.0
    /// A declined offer stays quiet for this long.
    static let quietPeriod: TimeInterval = 24 * 3600

    /// Where BookMaster has this book (0…1) when that is far enough ahead of
    /// this device to offer, otherwise nil. `bmRemotePercent` is 0–100 as
    /// BookMaster keeps it; `progression` is 0–1 as the readers keep it.
    static func target(for book: Book, now: Date = Date()) -> Double? {
        guard let remote = book.bmRemotePercent, remote.isFinite, remote > 0 else { return nil }
        // finished or given up on the shelf, or all the way through: nothing to pick up
        if book.bmStatus == "read" || book.bmStatus == "dnf" || book.bmStatus == "abandoned" || remote >= 99 { return nil }
        let local = max(book.progression ?? 0, 0) * 100
        guard remote - local >= margin else { return nil }
        if let declined = book.resumeDismissedAt, now.timeIntervalSince(declined) < quietPeriod {
            return nil
        }
        return min(remote, 100) / 100
    }

    /// Take the offer: the book now sits at BookMaster's place. The saved
    /// reading locator and audio second are dropped — the reader and the player
    /// both place a book by its progression when they have nothing more precise.
    static func accept(_ book: inout Book, fraction: Double) {
        book.progression = min(max(fraction, 0), 1)
        book.locatorJSON = nil
        book.audioPosition = nil
        book.resumeDismissedAt = nil
    }

    /// Turn it down: stay where this device is, and ask again no sooner than tomorrow.
    static func decline(_ book: inout Book, now: Date = Date()) {
        book.resumeDismissedAt = now
    }

    /// "62%".
    static func label(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded()))%"
    }
}
