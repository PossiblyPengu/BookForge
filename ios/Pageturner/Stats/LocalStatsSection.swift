import Charts
import SwiftUI

/// What the phone itself has seen: time read and listened, streaks, the last two
/// weeks as bars, and the books that took the most time. Works with no account.
struct LocalStatsSection: View {
    /// BookMaster is linked and shows the streaks and the all-time total itself: leave those rows out here.
    var compact = false
    @ObservedObject private var log = ReadingLog.shared

    var body: some View {
        let stats = log.stats
        let trends = ReadingTrends.summary(log.sessions)
        Group {
            Section {
                if log.sessions.isEmpty {
                    Text("Nothing logged yet. The time you spend reading and listening shows up here — kept on this phone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    LabeledContent("Today", value: ReadingStats.duration(minutes: stats.minutesToday))
                    LabeledContent("Last 7 days", value: ReadingStats.duration(minutes: stats.minutesLast7Days))
                    if !compact {
                        LabeledContent("Current streak", value: Self.days(stats.currentStreak))
                        LabeledContent("Longest streak", value: Self.days(stats.longestStreak))
                        LabeledContent("All time", value: ReadingStats.duration(minutes: stats.minutesTotal))
                    }
                    chart(stats.daily)
                }
            } header: {
                Text(compact ? "Lately, on this phone" : "On this device")
            }

            if !log.sessions.isEmpty {
                Section("Trends") {
                    LabeledContent("This week", value: Self.week(trends))
                    if trends.activeDays > 0 {
                        LabeledContent("Days you read, last 30", value: "\(trends.activeDays)")
                        LabeledContent("On those days", value: "\(ReadingStats.duration(minutes: trends.averageActiveDayMinutes)) on average")
                    }
                    weekChart(trends.weeks)
                }
            }

            if !stats.perBook.isEmpty {
                Section("Most time") {
                    ForEach(stats.perBook.prefix(5)) { total in
                        HStack(spacing: 10) {
                            Image(systemName: total.audio ? "headphones" : "book.closed")
                                .foregroundStyle(Color.ptAccent)
                                .frame(width: 22)
                                .accessibilityHidden(true)
                            Text(total.title).lineLimit(1)
                            Spacer(minLength: 8)
                            Text(ReadingStats.duration(minutes: total.minutes))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                }
            }
        }
    }

    private func chart(_ days: [ReadingStats.Day]) -> some View {
        Chart(days) { day in
            BarMark(
                x: .value("Day", day.date, unit: .day),
                y: .value("Minutes", day.minutes))
                .foregroundStyle(Color.ptAccent)
                .cornerRadius(3)
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day)) { _ in
                AxisValueLabel(format: .dateTime.weekday(.narrow), centered: true)
            }
        }
        .frame(height: 120)
        .padding(.vertical, 4)
        .accessibilityLabel("Minutes read per day, last \(days.count) days")
    }

    private func weekChart(_ weeks: [ReadingTrends.Week]) -> some View {
        Chart(weeks) { week in
            BarMark(
                x: .value("Week", week.start, unit: .weekOfYear),
                y: .value("Minutes", week.minutes))
                .foregroundStyle(Color.ptAccent)
                .cornerRadius(3)
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .weekOfYear, count: 2)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day(), centered: true)
            }
        }
        .frame(height: 110)
        .padding(.vertical, 4)
        .accessibilityLabel("Minutes read per week, last \(weeks.count) weeks")
    }

    /// "2h 05m" — and, when last week had something to compare, how it stands: "2h 05m (up 25%)".
    private static func week(_ trends: ReadingTrends.Summary) -> String {
        let time = ReadingStats.duration(minutes: trends.thisWeekMinutes)
        guard let change = trends.changeFromLastWeek, abs(change) >= 0.05 else { return time }
        let percent = Int((abs(change) * 100).rounded())
        return "\(time) (\(change > 0 ? "up" : "down") \(percent)%)"
    }

    private static func days(_ n: Int) -> String { n == 1 ? "1 day" : "\(n) days" }
}
