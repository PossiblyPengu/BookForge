import SwiftUI

/// The tracking tab: what this phone has seen of your reading (always), and — once BookMaster is linked —
/// its streak, goals and achievements, the shelf, the other reader and the suggestions waiting.
/// Reading is Pageturner's job; this is where it is tracked.
struct BookMasterView: View {
    @Environment(AppRouter.self) private var router
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var together: BMTogether?
    @State private var overview: BMOverview?
    @State private var showShelf = false
    @State private var debugScreen: BMScreen?
    @State private var error: String?
    @State private var loading = true
    @ObservedObject private var readingLog = ReadingLog.shared

    /// The deeper pages, for the simulator's -PTDebugScreen names.
    enum BMScreen: String, Identifiable {
        case progress, together, quotes, discover, find, wrapped, book
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 20) {
                    if linked {
                        linkedDashboard
                    } else {
                        unlinkedDashboard
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .ptReadableWidth()
            }
            .background(Color(uiColor: .systemGroupedBackground))
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

    @ViewBuilder
    private var linkedDashboard: some View {
        statusCard
        if loading, together == nil, overview == nil {
            ProgressView("Bringing BookMaster up to date…")
                .frame(maxWidth: .infinity, minHeight: 160)
                .bmCard()
        } else {
            if let overview {
                progressCard(overview)
                if !overview.goals.isEmpty { goalsCard(overview.goals) }
            }
            shelfDashboard
            if let together {
                togetherCard(together)
                if !together.nudges.isEmpty { suggestionsCard(together.nudges) }
                if !together.sent.isEmpty { waitingCard(together.sent) }
                if !together.notices.isEmpty { noticesCard(together.notices) }
            }
            exploreGrid
            deviceCard
            if let error {
                Label(error, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .bmCard()
            }
        }
    }

    @ViewBuilder
    private var unlinkedDashboard: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "books.vertical.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Color.ptAccent)
            VStack(alignment: .leading, spacing: 6) {
                Text("Your reading life, together")
                    .font(.title2.bold())
                Text("Link BookMaster to bring your shelf, streaks, goals, quotes and the other reader into Pageturner.")
                    .foregroundStyle(.secondary)
            }
            Button { router.showLink = true } label: {
                Label("Link BookMaster", systemImage: "link")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.ptAccent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .bmCard()

        deviceCard
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Color.ptAccent.opacity(0.14))
                    Image(systemName: "book.closed.fill").foregroundStyle(Color.ptAccent)
                }
                .frame(width: 46, height: 46)
                VStack(alignment: .leading, spacing: 2) {
                    Text(BookMaster.shared.user?.displayName ?? BookMaster.shared.user?.username ?? "BookMaster")
                        .font(.headline)
                    Label(BookMaster.shared.syncEnabled ? "Reading is syncing" : "Sync is paused",
                          systemImage: BookMaster.shared.syncEnabled ? "checkmark.circle.fill" : "pause.circle.fill")
                        .font(.caption)
                        .foregroundStyle(BookMaster.shared.syncEnabled ? Color.green : Color.orange)
                }
                Spacer()
                Toggle("Sync", isOn: Binding(
                    get: { BookMaster.shared.syncEnabled },
                    set: { BookMaster.shared.syncEnabled = $0 }))
                    .labelsHidden()
            }
            if let partner = together?.partner {
                Divider()
                HStack(spacing: 10) {
                    Circle()
                        .fill(partner.online ? Color.green : Color.secondary.opacity(0.35))
                        .frame(width: 9, height: 9)
                    Text(partner.online ? "\(partner.name) is here now" : "\(partner.name) is away")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    NavigationLink("Together") { BookMasterTogetherView() }
                        .font(.subheadline)
                }
            }
        }
        .bmCard()
    }

    private func progressCard(_ overview: BMOverview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Your momentum").font(.headline)
                    Text("Everything BookMaster has tracked")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                NavigationLink { BookMasterProgressView() } label: {
                    Image(systemName: "arrow.up.right")
                }
                .accessibilityLabel("Open progress")
            }
            HStack(spacing: 0) {
                metric("\(Int(overview.stats.currentStreak))", "day streak", "flame.fill", .orange)
                Divider().frame(height: 48)
                metric("\(Int(overview.stats.booksFinished))", "finished", "books.vertical.fill", .ptAccent)
                Divider().frame(height: 48)
                metric(Self.duration(minutes: Int(overview.stats.minutesRead)), "time read", "clock.fill", .blue)
            }
            if let achievement = overview.recentAchievements.first {
                Label("\(achievement.icon ?? "🏆")  \(achievement.name)", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .bmCard()
    }

    private func metric(_ value: String, _ label: String, _ icon: String, _ color: Color) -> some View {
        VStack(spacing: 5) {
            Image(systemName: icon).foregroundStyle(color)
            Text(value).font(.title3.bold()).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func goalsCard(_ goals: [BMGoal]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Goals", systemImage: "target").font(.headline)
                Spacer()
                NavigationLink("Progress") { BookMasterProgressView() }.font(.subheadline)
            }
            ForEach(goals.prefix(3), id: \.stableId) { goal in
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(Self.goalLabel(goal.type)).font(.subheadline.weight(.medium))
                        Spacer()
                        Text("\(Int(goal.current)) of \(Int(goal.target ?? 0))")
                            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                    ProgressView(value: min(1, max(0, goal.progress))).tint(.ptAccent)
                }
            }
        }
        .bmCard()
    }

    @ViewBuilder
    private var shelfDashboard: some View {
        let rows = BookMaster.shared.shelfRows
        let reading = rows.filter { $0.status == "reading" }
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reading.isEmpty ? "Your shelf" : "Reading now").font(.headline)
                        Text("\(rows.count) book\(rows.count == 1 ? "" : "s") in BookMaster")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    NavigationLink("See all") { BookMasterShelfView() }.font(.subheadline)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach((reading.isEmpty ? rows : reading).prefix(5)) { row in
                            NavigationLink { BookMasterDetailView(pin: row.userBookId) } label: {
                                shelfBook(row)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .contentMargins(.horizontal, 1, for: .scrollContent)
            }
            .bmCard()
        }
    }

    private func shelfBook(_ row: BMShelfRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            AsyncImage(url: row.coverURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Color.ptAccent.opacity(0.13).overlay {
                        Image(systemName: row.isAudio ? "headphones" : "book.closed.fill")
                            .font(.title2).foregroundStyle(Color.ptAccent)
                    }
                }
            }
            .frame(width: 118, height: 154)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text(row.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            Text(row.author ?? "Unknown author").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if let percent = row.percent {
                ProgressView(value: min(max(percent / 100, 0), 1)).tint(.ptAccent)
            }
        }
        .frame(width: 118, alignment: .leading)
    }

    private func togetherCard(_ value: BMTogether) -> some View {
        NavigationLink { BookMasterTogetherView() } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Together", systemImage: "person.2.fill").font(.headline)
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
                }
                if let partner = value.partner {
                    HStack(alignment: .top, spacing: 12) {
                        Circle()
                            .fill(partner.online ? Color.green.opacity(0.16) : Color.secondary.opacity(0.12))
                            .overlay {
                                Image(systemName: "person.fill")
                                    .foregroundStyle(partner.online ? Color.green : Color.secondary)
                            }
                            .frame(width: 44, height: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(partner.name).font(.subheadline.weight(.semibold))
                            if let book = partner.reading {
                                Text("Reading \(book.title)").font(.subheadline).lineLimit(1)
                                if let percent = book.percent {
                                    Text("\(Int(percent.rounded()))% through")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            } else {
                                Text("Nothing open right now").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Text("Invite the other reader to share books, progress and suggestions.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.primary)
            .bmCard()
        }
        .buttonStyle(.plain)
    }

    private func suggestionsCard(_ nudges: [BMNudge]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Waiting for you", systemImage: "sparkles").font(.headline)
            ForEach(nudges) { nudge in
                VStack(alignment: .leading, spacing: 8) {
                    Text(nudge.title).font(.headline)
                    Text("From \(nudge.fromName)\(nudge.author.map { " · \($0)" } ?? "")")
                        .font(.caption).foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty { Text("“\(note)”").font(.subheadline) }
                    HStack {
                        Button("Add to shelf") { Task { await answer(nudge, accept: true) } }
                            .buttonStyle(.borderedProminent).tint(.ptAccent)
                        Button("Not for me") { Task { await answer(nudge, accept: false) } }
                            .buttonStyle(.bordered)
                    }
                    .controlSize(.small)
                }
                if nudge.id != nudges.last?.id { Divider() }
            }
        }
        .bmCard()
    }

    private func waitingCard(_ sent: [BMSentNudge]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("You suggested", systemImage: "paperplane.fill").font(.headline)
            ForEach(sent.prefix(3)) { item in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text("To \(item.toName)").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(item.status.capitalized)
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
        }
        .bmCard()
    }

    private func noticesCard(_ notices: [BMNotice]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("From your apps", systemImage: "bell.badge.fill").font(.headline)
            ForEach(notices.prefix(3)) { notice in Text(notice.text).font(.subheadline) }
        }
        .bmCard()
    }

    private var exploreGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Explore BookMaster").font(.headline)
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible()), count: dynamicTypeSize.isAccessibilitySize ? 1 : 2),
                spacing: 12
            ) {
                destinationTile("Shelf", "books.vertical.fill", Color.ptAccent) { BookMasterShelfView() }
                destinationTile("Progress", "chart.line.uptrend.xyaxis", .blue) { BookMasterProgressView() }
                destinationTile("Quotes", "quote.bubble.fill", .purple) { BookMasterQuotesView() }
                destinationTile("Discover", "sparkles", .orange) { BookMasterDiscoverView() }
                destinationTile("Find a book", "magnifyingglass", .green) { BookMasterSearchView() }
                destinationTile("Year so far", "calendar", .pink) { BookMasterWrappedView() }
            }
        }
    }

    private func destinationTile<Destination: View>(
        _ title: String, _ icon: String, _ color: Color, @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.headline).foregroundStyle(color)
                    .frame(width: 32, height: 32)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var deviceCard: some View {
        let stats = readingLog.stats
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("On this iPhone").font(.headline)
                    Text("Private to this device").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                NavigationLink { BookMasterProgressView() } label: {
                    Image(systemName: "arrow.up.right")
                }
                .accessibilityLabel("Open progress")
            }
            if readingLog.sessions.isEmpty {
                Text("Reading and listening time will appear here after your first session.")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 0) {
                    metric(ReadingStats.duration(minutes: stats.minutesToday), "today", "sun.max.fill", .orange)
                    Divider().frame(height: 48)
                    metric(ReadingStats.duration(minutes: stats.minutesLast7Days), "last 7 days", "calendar", .blue)
                    Divider().frame(height: 48)
                    metric("\(stats.currentStreak)", "day streak", "flame.fill", .orange)
                }
            }
        }
        .bmCard()
    }

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

private extension View {
    func bmCard() -> some View {
        padding(18)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
    }
}
