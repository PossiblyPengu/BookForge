import Foundation

/// One sitting with a book, kept on this device whether or not BookMaster is linked.
struct ReadingSession: Codable, Identifiable, Hashable {
    var id = UUID()
    var bookID: UUID
    var title: String
    /// When the sitting ended.
    var end: Date
    var minutes: Double
    /// 0…1 through the book at either end.
    var progressStart: Double
    var progressEnd: Double
    var audio: Bool
}

/// Totals, streaks and a daily chart worked out from the sittings. Pure logic —
/// a `Calendar` and "now" are passed in so the day boundaries can be checked.
struct ReadingStats: Equatable {
    struct Day: Equatable, Identifiable {
        /// Start of the day.
        var date: Date
        var minutes: Double
        var id: Date { date }
    }

    struct BookTotal: Equatable, Identifiable {
        var bookID: UUID
        var title: String
        var minutes: Double
        var audio: Bool
        var id: UUID { bookID }
    }

    var minutesToday = 0.0
    var minutesLast7Days = 0.0
    var minutesTotal = 0.0
    var sessionCount = 0
    /// Days in a row up to today — or up to yesterday, while today hasn't started yet.
    var currentStreak = 0
    var longestStreak = 0
    /// The last `days` days, oldest first, today last.
    var daily: [Day] = []
    /// Most time first.
    var perBook: [BookTotal] = []

    /// A day counts towards a streak with at least this many minutes.
    static let streakMinutes = 1.0

    static func compute(
        _ sessions: [ReadingSession], now: Date = Date(), calendar: Calendar = .current, days: Int = 14
    ) -> ReadingStats {
        let today = calendar.startOfDay(for: now)
        func day(_ offset: Int, from date: Date) -> Date { calendar.date(byAdding: .day, value: offset, to: date) ?? date }

        var perDay: [Date: Double] = [:]
        var books: [UUID: BookTotal] = [:]
        var stats = ReadingStats()
        for session in sessions where session.minutes > 0 && session.minutes.isFinite {
            perDay[calendar.startOfDay(for: session.end), default: 0] += session.minutes
            stats.minutesTotal += session.minutes
            stats.sessionCount += 1
            var total = books[session.bookID] ?? BookTotal(bookID: session.bookID, title: session.title, minutes: 0, audio: session.audio)
            total.minutes += session.minutes
            total.title = session.title   // the most recent name wins
            books[session.bookID] = total
        }

        stats.minutesToday = perDay[today] ?? 0
        stats.minutesLast7Days = (0..<7).reduce(0) { $0 + (perDay[day(-$1, from: today)] ?? 0) }
        stats.daily = (0..<max(days, 0)).reversed().map { back in
            let date = day(-back, from: today)
            return Day(date: date, minutes: perDay[date] ?? 0)
        }
        stats.perBook = books.values.sorted {
            $0.minutes != $1.minutes ? $0.minutes > $1.minutes : $0.title < $1.title
        }

        // streaks run over the days that count
        let active = Set(perDay.filter { $0.value >= streakMinutes }.keys)
        var cursor = active.contains(today) ? today : day(-1, from: today)
        while active.contains(cursor) {
            stats.currentStreak += 1
            cursor = day(-1, from: cursor)
        }
        var run = 0
        var previous: Date?
        for date in active.sorted() {
            if let previous, day(1, from: previous) == date { run += 1 } else { run = 1 }
            stats.longestStreak = max(stats.longestStreak, run)
            previous = date
        }
        return stats
    }

    /// "1h 05m", "42m", "0m".
    static func duration(minutes: Double) -> String {
        let total = Int(minutes.rounded())
        if total <= 0 { return "0m" }
        return total >= 60 ? String(format: "%dh %02dm", total / 60, total % 60) : "\(total)m"
    }
}
