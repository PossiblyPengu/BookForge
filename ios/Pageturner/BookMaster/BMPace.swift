import Foundation

/// How fast a book is going down, from the sittings BookMaster logged — the
/// web's PaceWidget: pages a day over the last seven sessions, and the day
/// count and date that pace lands on the end. Pure, checked off-device.
enum BMPace {
    /// The two numbers the widget spells: pace a day and days to the finish.
    struct Estimate: Equatable {
        var pagesPerDay: Double
        var daysLeft: Int
    }

    /// Nil when there is nothing to say — fewer than two sessions, no page
    /// count, a pace of zero, or already at the last page.
    static func estimate(sessions: [BMSession], totalPages: Int?, currentPage: Double?) -> Estimate? {
        guard let totalPages, totalPages > 0, let currentPage else { return nil }
        let recent = Array(sessions.prefix(7))
        guard recent.count >= 2 else { return nil }

        let pagesRead = recent.reduce(0.0) { $0 + ($1.pagesRead ?? 0) }
        guard pagesRead > 0 else { return nil }

        // Days between the earliest and latest of those sittings, both ends
        // counted — the same day-span the web counts.
        let days = recent.compactMap(\.sessionDate).sorted()
        let span: Double
        if days.count > 1,
           let first = parseDay(days.first!), let last = parseDay(days.last!) {
            span = max(1, last.timeIntervalSince(first) / 86400 + 1)
        } else {
            span = 1
        }

        let perDay = pagesRead / span
        guard perDay > 0 else { return nil }
        let left = Double(totalPages) - currentPage
        guard left > 0 else { return nil }
        return Estimate(pagesPerDay: perDay, daysLeft: Int((left / perDay).rounded(.up)))
    }

    /// The line it spells: "about 24 pages a day · finish by Mar 4 (12d)".
    static func label(_ estimate: Estimate, now: Date = Date()) -> String {
        let perDay = Int(estimate.pagesPerDay.rounded())
        var text = "about \(perDay) page\(perDay == 1 ? "" : "s") a day"
        if estimate.daysLeft < 365,
           let finish = Calendar.current.date(byAdding: .day, value: estimate.daysLeft, to: now) {
            let when = finish.formatted(.dateTime.month(.abbreviated).day())
            text += " · finish by \(when) (\(estimate.daysLeft)d)"
        }
        return text
    }

    /// `session_date` is ISO `YYYY-MM-DD`; read it in UTC so a late-evening
    /// sitting is still the day the server meant, whichever zone parses it.
    private static func parseDay(_ day: String) -> Date? {
        let parts = day.split(separator: "-")
        guard parts.count == 3,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: y, month: m, day: d))
    }
}
