import SwiftUI

/// The Progress page of BookMaster: level and XP, the numbers the year holds,
/// the last month's days, everything on the go, the badge wall — and the way
/// to the wrap. What the home tab glances at, all of it here.
struct BookMasterProgressView: View {
    @State private var stats: BMStatBlock?
    @State private var overview: BMOverview?
    @State private var achievements: [BMAchievementFull]?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        List {
            if let stats {
                levelSection(stats)
                numbersSection(stats)
                if !stats.currentlyReading.isEmpty { readingSection(stats.currentlyReading) }
                if !stats.recentActivity.isEmpty { activitySection(stats.recentActivity) }
            }
            if let overview, !overview.goals.isEmpty { goalsSection(overview.goals) }
            if let achievements { achievementsSection(achievements) }
            Section {
                NavigationLink { BookMasterWrappedView() } label: {
                    Label("The year so far", systemImage: "calendar")
                }
            }
            if loading, stats == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let error { Section { Text(error).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Progress")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    /// Level and how far the next one is.
    private func levelSection(_ stats: BMStatBlock) -> some View {
        Section {
            HStack {
                Text("Level \(stats.level)").font(.title2.weight(.bold))
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(Int(stats.xp)) XP")
                        .font(.headline)
                    if let next = stats.xpForNext {
                        Text("\(Int(next)) to level \(stats.level + 1)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            ProgressView(value: min(1, max(0, stats.xpProgress ?? 0)))
                .tint(.ptAccent)
        }
    }

    /// The counters the year holds.
    private func numbersSection(_ stats: BMStatBlock) -> some View {
        Section("Totals") {
            if let streak = stats.currentStreak {
                LabeledContent("Current streak", value: "\(Int(streak)) days")
            }
            if let longest = stats.longestStreak {
                LabeledContent("Longest streak", value: "\(Int(longest)) days")
            }
            if let books = stats.booksFinished {
                LabeledContent("Books finished", value: "\(Int(books))")
            }
            if let pages = stats.totalPages {
                LabeledContent("Pages read", value: "\(Int(pages))")
            }
            if let minutes = stats.minutesRead {
                LabeledContent("Time read", value: Self.duration(minutes: Int(minutes)))
            }
            if let quotes = stats.quotesSaved {
                LabeledContent("Quotes saved", value: "\(Int(quotes))")
            }
            if let authors = stats.authorsRead {
                LabeledContent("Authors read", value: "\(Int(authors))")
            }
            if let genres = stats.genresRead {
                LabeledContent("Genres", value: "\(Int(genres))")
            }
        }
    }

    /// The books on the go, as BookMaster sees them.
    private func readingSection(_ rows: [BMReadingRow]) -> some View {
        Section("On the go") {
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title).font(.body.weight(.medium)).lineLimit(2)
                    HStack(spacing: 6) {
                        if let author = row.author, !author.isEmpty { Text(author) }
                        if let percent = row.percent { Text("· \(Int(percent.rounded()))%") }
                        if row.format == "audio" { Text("· audio") }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The last month's days, as text — how many sittings and how many pages each.
    private func activitySection(_ days: [BMActivityDay]) -> some View {
        Section("The last month") {
            ForEach(Array(days.suffix(10).enumerated()), id: \.element.sessionDate) { _, day in
                LabeledContent(
                    day.sessionDate,
                    value: "\(day.sessions ?? 0) · \(Int(day.pages ?? 0)) pages")
            }
        }
    }

    /// Goals the year sets, with their bars.
    private func goalsSection(_ goals: [BMGoal]) -> some View {
        Section("Goals") {
            ForEach(goals, id: \.stableId) { goal in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(Self.goalLabel(goal.type))
                        Spacer()
                        Text("\(Int(goal.current)) / \(Int(goal.target ?? 0))")
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: min(1, max(0, goal.progress)))
                        .tint(.ptAccent)
                }
                .padding(.vertical, 2)
            }
        }
    }

    /// The badge wall — earned first, the rest with how far they've got.
    private func achievementsSection(_ all: [BMAchievementFull]) -> some View {
        Section("Achievements") {
            ForEach(all) { badge in
                HStack(spacing: 12) {
                    Text(badge.icon ?? "🏆").font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(badge.name ?? "Achievement")
                            .font(.body.weight(badge.earned ? .semibold : .regular))
                        if let description = badge.description, !description.isEmpty {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    if badge.earned {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(Color.ptAccent)
                    } else if let progress = badge.progress, progress > 0 {
                        Text("\(Int((progress * 100).rounded()))%")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .opacity(badge.earned ? 1 : 0.75)
            }
        }
    }

    private func load() async {
        guard BookMaster.shared.isLinked else {
            stats = nil
            overview = nil
            achievements = nil
            loading = false
            return
        }
        async let s = try? await BookMaster.shared.fetchStats()
        async let o = try? await BookMaster.shared.fetchOverview()
        async let a = try? await BookMaster.shared.fetchAchievements()
        let (stats, overview, achievements) = await (s, o, a)
        guard !Task.isCancelled else { return }
        if let stats { self.stats = stats }
        if let overview { self.overview = overview }
        if let achievements { self.achievements = achievements }
        error = (stats == nil && self.stats == nil) ? "BookMaster can’t be reached right now." : nil
        loading = false
    }

    private static func duration(minutes: Int) -> String {
        minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    private static func goalLabel(_ type: String) -> String {
        switch type {
        case "yearly_books": return "Books this year"
        case "yearly_pages": return "Pages this year"
        case "monthly_books": return "Books this month"
        default: return type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
