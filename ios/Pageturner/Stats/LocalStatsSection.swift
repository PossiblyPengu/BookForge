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

    private static func days(_ n: Int) -> String { n == 1 ? "1 day" : "\(n) days" }
}
