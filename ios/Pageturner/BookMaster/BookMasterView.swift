import SwiftUI

/// The tracking tab: what this phone has seen of your reading (always), and — once BookMaster is linked —
/// its streak, goals and achievements, the shelf, the other reader and the suggestions waiting.
/// Reading is Pageturner's job; this is where it is tracked.
struct BookMasterView: View {
    @Environment(AppRouter.self) private var router
    @State private var together: BMTogether?
    @State private var overview: BMOverview?
    @State private var showShelf = false
    @State private var debugScreen: BMScreen?
    @State private var error: String?
    @State private var loading = true

    /// The deeper pages, for the simulator's -PTDebugScreen names.
    enum BMScreen: String, Identifiable {
        case progress, together, quotes, discover, find, wrapped, book
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            List {
                if linked {
                    accountSection
                    if let overview { overviewSections(overview) }
                } else {
                    linkSection
                }
                // this phone's own record — with BookMaster linked its streaks and totals are the ones above
                LocalStatsSection(compact: linked)
                if linked {
                    placesSection
                    shelfSection
                    if let together {
                        partnerSection(together.partner)
                        if !together.nudges.isEmpty { nudgeSection(together.nudges) }
                        if !together.sent.isEmpty { sentSection(together.sent) }
                        if !together.notices.isEmpty { noticeSection(together.notices) }
                    }
                    if let error { Section { Text(error).foregroundStyle(.secondary) } }
                    if loading, together == nil, overview == nil {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                    }
                }
            }
            .navigationDestination(isPresented: $showShelf) { BookMasterShelfView() }
            .navigationDestination(item: $debugScreen) { screen in
                switch screen {
                case .progress: BookMasterProgressView()
                case .together: BookMasterTogetherView()
                case .quotes: BookMasterQuotesView()
                case .discover: BookMasterDiscoverView()
                case .find: BookMasterSearchView()
                case .wrapped: BookMasterWrappedView()
                case .book: BookMasterDetailView(pin: "u1")
                }
            }
            #if DEBUG
            .task {
                switch UserDefaults.standard.string(forKey: "PTDebugScreen") {
                case "shelf": showShelf = true
                case "bmprogress": debugScreen = .progress
                case "bmtogether": debugScreen = .together
                case "bmquotes": debugScreen = .quotes
                case "bmdiscover": debugScreen = .discover
                case "bmsearch": debugScreen = .find
                case "bmwrapped": debugScreen = .wrapped
                case "bmbook": debugScreen = .book
                default: break
                }
            }
            #endif
            .navigationTitle("BookMaster")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { router.showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .refreshable { await load() }
            // again when the account is linked or unlinked while the tab is up
            .task(id: BookMaster.shared.isLinked) { await load() }
        }
        // the stack, not the list: a pushed pane is still the BookMaster tab
        .onAppear { BookMaster.shared.place = "bookmaster" }
        .onDisappear { BookMaster.shared.place = "library" }
    }

    private var linked: Bool { BookMaster.shared.isLinked }

    /// The way to every part of BookMaster the bridge reaches — the glance
    /// rows below stay glance-sized; these open the whole pages.
    private var placesSection: some View {
        Section {
            NavigationLink {
                BookMasterProgressView()
            } label: {
                Label("Progress", systemImage: "chart.line.uptrend.xyaxis")
            }
            NavigationLink {
                BookMasterShelfView()
            } label: {
                Label("Your Shelf", systemImage: "books.vertical")
            }
            NavigationLink {
                BookMasterTogetherView()
            } label: {
                Label("Together", systemImage: "person.2")
            }
            NavigationLink {
                BookMasterQuotesView()
            } label: {
                Label("Quotes & notes", systemImage: "quote.bubble")
            }
            NavigationLink {
                BookMasterDiscoverView()
            } label: {
                Label("What to read next", systemImage: "sparkles")
            }
            NavigationLink {
                BookMasterSearchView()
            } label: {
                Label("Find a book", systemImage: "magnifyingglass")
            }
            NavigationLink {
                BookMasterWrappedView()
            } label: {
                Label("The year so far", systemImage: "calendar")
            }
        } footer: {
            Text("Streaks, the shelf, the other reader, quotes, suggestions and the year’s wrap — all of BookMaster, in here.")
        }
    }

    /// Not linked yet: the way in, in a line.
    private var linkSection: some View {
        Section {
            Button { router.showLink = true } label: {
                Label("Link BookMaster", systemImage: "link")
            }
        } footer: {
            Text("Track streaks and goals, keep your shelf, and see what the other reader is on. Your reading time below is kept on this phone either way.")
        }
    }

    private var accountSection: some View {
        Section {
            if let user = BookMaster.shared.user {
                Label(user.displayName ?? user.username, systemImage: "checkmark.seal.fill").foregroundStyle(.green)
            }
            Toggle("Send progress and sessions", isOn: Binding(
                get: { BookMaster.shared.syncEnabled },
                set: { BookMaster.shared.syncEnabled = $0 }))
        } footer: {
            Text("Pageturner is for reading. What you read is tracked here.")
        }
    }

    @ViewBuilder
    private func overviewSections(_ overview: BMOverview) -> some View {
        Section("Streak and totals") {
            LabeledContent("Current streak", value: "\(Int(overview.stats.currentStreak)) days")
            LabeledContent("Longest streak", value: "\(Int(overview.stats.longestStreak)) days")
            LabeledContent("Books finished", value: "\(Int(overview.stats.booksFinished))")
            LabeledContent("Time read", value: Self.duration(minutes: Int(overview.stats.minutesRead)))
            LabeledContent("Quotes saved", value: "\(Int(overview.stats.quotesSaved))")
        }
        if !overview.goals.isEmpty {
            Section("Goals") {
                ForEach(overview.goals, id: \.stableId) { goal in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(Self.goalLabel(goal.type))
                            Spacer()
                            Text("\(Int(goal.current)) / \(Int(goal.target ?? 0))").foregroundStyle(.secondary)
                        }
                        ProgressView(value: min(1, max(0, goal.progress)))
                            .tint(.ptAccent)
                            .ptAnimation(.smooth(duration: 0.6), value: goal.progress)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        if !overview.recentAchievements.isEmpty {
            Section("Recent achievements") {
                ForEach(overview.recentAchievements) { a in Text("\(a.icon ?? "🏆") \(a.name)") }
            }
        }
    }

    /// A glance at the shelf — what is up next, or being read — and the way to all of it.
    @ViewBuilder
    private var shelfSection: some View {
        let rows = BookMaster.shared.shelfRows
        let glance = BMShelf.groups(rows).first
        if let glance {
            Section("Your Shelf") {
                ForEach(glance.rows.prefix(3)) { row in
                    NavigationLink { BookMasterShelfView() } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title).lineLimit(1)
                            Text("\(glance.title)\(row.author.map { " · \($0)" } ?? "")")
                                .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                NavigationLink { BookMasterShelfView() } label: {
                    Label("All \(rows.count) books", systemImage: "books.vertical")
                }
            }
        }
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

    @ViewBuilder
    private func partnerSection(_ partner: BMPartner?) -> some View {
        Section {
            if let partner {
                HStack {
                    Circle()
                        .fill(partner.online ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 10, height: 10)
                    Text(partner.name).font(.headline)
                    Spacer()
                    Text(partner.online ? "Here now" : "Away").font(.caption).foregroundStyle(.secondary)
                }
                if let reading = partner.reading {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reading.title)
                        HStack {
                            if let author = reading.author { Text(author) }
                            if let percent = reading.percent {
                                Text("· \(Int(percent.rounded()))%")
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Not reading anything right now").foregroundStyle(.secondary)
                }
            } else {
                Text("No one else on this BookMaster yet").foregroundStyle(.secondary)
            }
        }
    }

    private func nudgeSection(_ nudges: [BMNudge]) -> some View {
        Section("Suggested for you") {
            ForEach(nudges) { nudge in
                VStack(alignment: .leading, spacing: 6) {
                    Text(nudge.title).font(.headline)
                    Text("From \(nudge.fromName)\(nudge.author.map { " · \($0)" } ?? "")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty {
                        Text("“\(note)”").font(.callout)
                    }
                    HStack {
                        Button("Add to want to read") { Task { await answer(nudge, accept: true) } }
                            .buttonStyle(.borderedProminent)
                        Button("Dismiss") { Task { await answer(nudge, accept: false) } }
                            .buttonStyle(.bordered)
                    }
                    .controlSize(.small)
                }
                .padding(.vertical, 2)
            }
        }
    }

    /// Suggestions of yours still out with the other reader.
    private func sentSection(_ sent: [BMSentNudge]) -> some View {
        Section("Waiting on them") {
            ForEach(sent) { nudge in
                VStack(alignment: .leading, spacing: 4) {
                    Text(nudge.title).font(.headline)
                    Text("To \(nudge.toName) · \(nudge.status)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty {
                        Text("“\(note)”").font(.callout)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func noticeSection(_ notices: [BMNotice]) -> some View {
        Section("From the other apps") {
            ForEach(notices) { notice in Text(notice.text) }
        }
    }

    private func load() async {
        guard BookMaster.shared.isLinked else {
            together = nil
            overview = nil
            error = nil
            loading = false
            return
        }
        async let fetchedTogether = try? await BookMaster.shared.fetchTogether()
        async let fetchedOverview = try? await BookMaster.shared.fetchOverview()
        let (fresh, stats) = await (fetchedTogether, fetchedOverview)
        guard !Task.isCancelled else { return }   // the tab was left mid-load: that is no "can't be reached"
        if let fresh {
            together = fresh
            Notifier.shared.noteSeen(fresh)
        }
        if let stats { overview = stats }
        error = (fresh == nil && stats == nil && together == nil && overview == nil)
            ? "BookMaster can’t be reached right now." : nil
        loading = false
    }

    private func answer(_ nudge: BMNudge, accept: Bool) async {
        do {
            try await BookMaster.shared.answerNudge(id: nudge.id, accept: accept)
            together?.nudges.removeAll { $0.id == nudge.id }
            if let together { Notifier.shared.noteSeen(together) }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
