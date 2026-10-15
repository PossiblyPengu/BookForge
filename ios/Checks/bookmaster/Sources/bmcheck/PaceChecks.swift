import Foundation

/// The BookMaster pace widget: pages a day from the last seven sittings, and
/// the day count that pace lands on the end — the web's PaceWidget arithmetic.
func runPaceChecks() {
    section("BookMaster pace")
    func sitting(_ date: String, _ from: Double, _ to: Double) -> BMSession {
        BMSession(id: UUID().uuidString, pagesStart: from, pagesEnd: to,
                  durationMinutes: nil, sessionDate: date,
                  listenedStart: nil, listenedEnd: nil)
    }

    check("one sitting is not a pace",
          BMPace.estimate(sessions: [sitting("2025-03-01", 0, 30)],
                          totalPages: 300, currentPage: 30) == nil)
    check("no page count, no pace",
          BMPace.estimate(sessions: [sitting("2025-03-01", 0, 30), sitting("2025-03-02", 30, 60)],
                          totalPages: nil, currentPage: 60) == nil)
    check("at the last page there is nothing left to pace",
          BMPace.estimate(sessions: [sitting("2025-03-01", 0, 30), sitting("2025-03-02", 30, 300)],
                          totalPages: 300, currentPage: 300) == nil)

    // Two sittings a day apart, 30 pages each → 30 pages a day; 240 pages left → 8 days.
    let steady = [sitting("2025-03-01", 0, 30), sitting("2025-03-02", 30, 60)]
    let estimate = BMPace.estimate(sessions: steady, totalPages: 300, currentPage: 60)
    check("30 pages a day finishes in 8 days",
          estimate?.pagesPerDay == 30 && estimate?.daysLeft == 8,
          "\(String(describing: estimate))")

    // Same-day sittings still count as one day — no divide-by-zero.
    let sameDay = [sitting("2025-03-01", 0, 20), sitting("2025-03-01", 20, 50)]
    check("two sittings on one day pace the day's total",
          BMPace.estimate(sessions: sameDay, totalPages: 300, currentPage: 50)?.pagesPerDay == 50)

    // A week between the first and last of seven sittings → span counts both ends.
    var week: [BMSession] = []
    for i in 0..<7 {
        week.append(sitting("2025-03-0\(7 - i)", Double(210 - i * 30 - 30), Double(210 - i * 30)))
    }
    // sessions arrive newest-first; dates 03-01…03-07, 30 pages each, span 7 days → 30/day
    let w = BMPace.estimate(sessions: week, totalPages: 300, currentPage: 210)
    check("a seven-sitting week paces 30 a day",
          w?.pagesPerDay == 30 && w?.daysLeft == 3, "\(String(describing: w))")

    check("the label spells the day count",
          BMPace.label(Estimate(pagesPerDay: 30, daysLeft: 8)).contains("pages a day"))
}

private typealias Estimate = BMPace.Estimate
