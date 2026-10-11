import SwiftUI

/// Reading time and streaks from this phone, and — when BookMaster is linked —
/// its streaks, totals, goals and achievements.
struct StatsView: View {
    /// Inside a tab: no Done button, the tab bar is the way out.
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router
    @State private var overview: BMOverview?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                LocalStatsSection()
                if !BookMaster.shared.isLinked {
                    Section {
                        Button {
                            router.showLink = true
                        } label: {
                            Label("Link BookMaster for goals and achievements", systemImage: "link")
                        }
                    }
                } else if let overview {
                    Section("On BookMaster") {
                        stat("Current streak", "\(Int(overview.stats.currentStreak)) days")
                        stat("Longest streak", "\(Int(overview.stats.longestStreak)) days")
                        stat("Books finished", "\(Int(overview.stats.booksFinished))")
                        stat("Time read", Self.duration(minutes: Int(overview.stats.minutesRead)))
                        stat("Quotes saved", "\(Int(overview.stats.quotesSaved))")
                    }
                    if !overview.goals.isEmpty {
                        Section("Goals") {
                            ForEach(overview.goals, id: \.stableId) { goal in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(Self.goalLabel(goal.type))
                                        Spacer()
                                        Text("\(Int(goal.current)) / \(Int(goal.target ?? 0))")
                                            .foregroundStyle(.secondary)
                                    }
                                    ProgressView(value: min(1, max(0, goal.progress)))
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                    if !overview.recentAchievements.isEmpty {
                        Section("Recent achievements") {
                            ForEach(overview.recentAchievements) { a in
                                Text("\(a.icon ?? "🏆") \(a.name)")
                            }
                        }
                    }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let error {
                    Section { Text(error).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Reading Stats")
            .navigationBarTitleDisplayMode(embedded ? .large : .inline)
            .toolbar {
                if !embedded {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .refreshable { await load() }
            // again when the account is linked or unlinked while the tab is up
            .task(id: BookMaster.shared.isLinked) { await load() }
            .onAppear { if embedded { BookMaster.shared.place = "stats" } }
            .onDisappear { if embedded { BookMaster.shared.place = "library" } }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        LabeledContent(label, value: value)
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

    private func load() async {
        guard BookMaster.shared.isLinked else {
            loading = false
            return
        }
        do {
            overview = try await BookMaster.shared.fetchOverview()
            error = nil
        } catch {
            if overview == nil { self.error = error.localizedDescription }
        }
        loading = false
    }
}
