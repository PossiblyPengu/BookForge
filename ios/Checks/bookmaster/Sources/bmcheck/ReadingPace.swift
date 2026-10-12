import Foundation

/// How long this reader takes, from the sittings kept on the phone — for "about 1 h 12 min left". Pure logic,
/// checked off-device (ios/Checks/bookmaster).
enum ReadingPace {
    /// Minutes to read a whole book: from this book's own sittings when they cover enough of it, else from all
    /// the text sittings. Nil when there is no history to go on, or the pace is not believable (a book left open).
    static func minutesPerBook(_ sessions: [ReadingSession], bookID: UUID? = nil) -> Double? {
        func pace(_ list: [ReadingSession]) -> Double? {
            let usable = list.filter { !$0.audio && $0.minutes >= 1 && ($0.progressEnd - $0.progressStart) >= 0.005 }
            let covered = usable.reduce(0.0) { $0 + ($1.progressEnd - $1.progressStart) }
            let minutes = usable.reduce(0.0) { $0 + $1.minutes }
            guard covered >= 0.02, minutes > 0 else { return nil }
            let perBook = minutes / covered
            return perBook.isFinite && (30 ... 3000).contains(perBook) ? perBook : nil
        }
        if let bookID, let own = pace(sessions.filter { $0.bookID == bookID }) { return own }
        return pace(sessions)
    }

    /// Minutes left at `progress` (0…1), or nil at the very start/end where an estimate means little.
    static func minutesLeft(progress: Double, minutesPerBook: Double) -> Double? {
        guard progress.isFinite, progress >= 0, progress < 0.995, minutesPerBook > 0 else { return nil }
        return (1 - progress) * minutesPerBook
    }

    static func label(minutesLeft: Double) -> String {
        let minutes = Int(minutesLeft.rounded())
        if minutes < 1 { return "under a minute left" }
        if minutes < 60 { return "~\(minutes) min left" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "~\(h) h left" : "~\(h) h \(m) min left"
    }
}
