import SwiftUI

/// The day's reading as a ring: minutes so far against a goal the reader sets, and the streak behind it.
struct ReadingGoalCard: View {
    @ObservedObject private var log = ReadingLog.shared
    @AppStorage("daily-goal-min") private var goal = 20

    var body: some View {
        let stats = log.stats
        let today = stats.minutesToday
        let target = Double(max(goal, 1))
        let reached = today >= target
        HStack(spacing: 16) {
            ZStack {
                Circle().stroke(Color.ptAccent.opacity(0.18), lineWidth: 9)
                Circle()
                    .trim(from: 0, to: min(today / target, 1))
                    .stroke(Color.ptAccent, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .ptAnimation(.smooth(duration: 0.6), value: today)
                Image(systemName: reached ? "checkmark" : "book.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.ptAccent)
            }
            .frame(width: 58, height: 58)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(reached ? "Goal reached" : "Today")
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.ptAccent)
                Text("\(ReadingStats.duration(minutes: today)) of \(goal) min")
                    .font(.headline)
                if stats.currentStreak > 0 {
                    Label("\(stats.currentStreak)-day streak", systemImage: "flame.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Menu {
                Picker("Daily goal", selection: $goal) {
                    ForEach([10, 15, 20, 30, 45, 60], id: \.self) { Text("\($0) minutes").tag($0) }
                }
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Daily goal, \(goal) minutes")
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Today, \(ReadingStats.duration(minutes: today)) of \(goal) minutes\(stats.currentStreak > 0 ? ", \(stats.currentStreak) day streak" : "")")
    }
}

/// The next volume after one just finished.
struct NextInSeriesRow: View {
    let book: Book
    let cover: UIImage?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            BookCoverView(book: book, cover: cover, showsBadges: false, corner: 6)
                .frame(width: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("Next in \(book.series ?? "the series")")
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.ptAccent)
                Text(book.title).font(.subheadline.weight(.medium)).lineLimit(2)
            }
            Spacer(minLength: 0)
            Button(action: action) {
                Text(book.isAudio ? "Play" : "Read").font(.subheadline.weight(.semibold))
            }
            .ptButtonStyle(prominent: true)
            .controlSize(.small)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .accessibilityElement(children: .contain)
    }
}

/// What the other reader has been up to, on the Reading tab: their book and a count of suggestions waiting.
struct PartnerStrip: View {
    @Environment(AppRouter.self) private var router
    @State private var together: BMTogether?

    var body: some View {
        Group {
            if let partner = together?.partner {
                Button { router.tab = .together } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "person.2.fill")
                            .foregroundStyle(Color.ptAccent)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line(partner))
                                .font(.subheadline.weight(.medium))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            if let waiting = together?.nudges.count, waiting > 0 {
                                Text("\(waiting) \(waiting == 1 ? "suggestion" : "suggestions") waiting")
                                    .font(.caption)
                                    .foregroundStyle(Color.ptAccent)
                            } else if let notice = together?.notices.first {
                                Text(notice.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .task {
            guard BookMaster.shared.isLinked, together == nil else { return }
            together = try? await BookMaster.shared.fetchTogether()
        }
    }

    private func line(_ partner: BMPartner) -> String {
        if let reading = partner.reading {
            let percent = reading.percent.map { " (\(Int($0.rounded()))%)" } ?? ""
            return "\(partner.name) is on \(reading.title)\(percent)"
        }
        return partner.online ? "\(partner.name) is online" : partner.name
    }
}
