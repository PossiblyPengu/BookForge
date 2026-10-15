import SwiftUI

/// The BookMaster shelf, whole — what the web calls Library. Reading now, the
/// up-next queue, the to-read pile (with a pick-for-me when choosing is the
/// hard part), and every other row behind filters, sort and search. Rows
/// without a file here are normal: BookMaster holds any book, Pageturner's
/// library holds the files it reads.
struct BookMasterBooksView: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    /// Which shelf row is which book in the library — worked out when either changes.
    @State private var owned: [String: UUID] = [:]
    @State private var filter: Filter = .all
    @State private var sort: Sort = .queue
    @State private var query = ""
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var pick: BMShelfRow?
    @State private var pushing: Push?
    @State private var error: String?

    /// A destination the tab pushes — also the -PTDebugScreen names.
    enum Push: String, Identifiable {
        case discover, quotes, series, find, wrapped, book
        var id: String { rawValue }
    }

    private enum Filter: String, CaseIterable, Identifiable {
        case all = "All", reading = "Reading", upNext = "Up next"
        case toRead = "To read", finished = "Finished", paused = "Paused"
        var id: String { rawValue }
    }

    private enum Sort: String, CaseIterable, Identifiable {
        case queue = "Shelf order", title = "Title", author = "Author", progress = "Progress"
        var id: String { rawValue }
    }

    private var rows: [BMShelfRow] { BookMaster.shared.shelfRows }
    private var reading: [BMShelfRow] { rows.filter { $0.status == "reading" } }
    private var queue: [BMShelfRow] { rows.filter { $0.upNext != nil }.sorted { ($0.upNext ?? 0) < ($1.upNext ?? 0) } }
    private var toRead: [BMShelfRow] { rows.filter { $0.status == "want_to_read" } }

    /// The visible shelf: the filter first, then the sort, then the query.
    private var visible: [BMShelfRow] {
        var list = rows
        switch filter {
        case .all: break
        case .reading: list = list.filter { $0.status == "reading" }
        case .upNext: list = list.filter { $0.upNext != nil }
        case .toRead: list = list.filter { $0.status == "want_to_read" }
        case .finished: list = list.filter { $0.status == "read" }
        case .paused: list = list.filter { $0.status == "abandoned" }
        }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            list = list.filter {
                $0.title.lowercased().contains(q) || ($0.author ?? "").lowercased().contains(q)
            }
        }
        switch sort {
        case .queue: break   // the pull order already reads reading → queued → the rest
        case .title: list.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .author: list.sort { ($0.author ?? "").localizedCaseInsensitiveCompare($1.author ?? "") == .orderedAscending }
        case .progress: list.sort { ($0.percent ?? -1) > ($1.percent ?? -1) }
        }
        return list
    }

    private func local(_ row: BMShelfRow) -> Book? {
        owned[row.userBookId].flatMap { id in library.books.first { $0.id == id } }
    }

    private func matchBooks() {
        var found: [String: UUID] = [:]
        for row in rows {
            if let book = library.books.first(where: { BMShelf.match($0, in: [row]) != nil }) {
                found[row.userBookId] = book.id
            }
        }
        owned = found
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 20) {
                    if BookMaster.shared.isLinked {
                        linkedBody
                    } else {
                        BMLinkPrompt()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .ptReadableWidth()
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationDestination(item: $pushing) { push in
                switch push {
                case .discover: BookMasterDiscoverView()
                case .quotes: BookMasterQuotesView()
                case .series: BMSeriesView()
                case .find: BookMasterSearchView()
                case .wrapped: BookMasterWrappedView()
                case .book: BookMasterDetailView(pin: "u1")
                }
            }
            .navigationDestination(item: $pick) { row in
                BookMasterDetailView(pin: row.userBookId)
            }
            #if DEBUG
            .task {
                switch UserDefaults.standard.string(forKey: "PTDebugScreen") {
                case "bmquotes": pushing = .quotes
                case "bmdiscover": pushing = .discover
                case "bmsearch": pushing = .find
                case "bmseries": pushing = .series
                case "bmbook": pushing = .book
                default: break
                }
            }
            #endif
            .navigationTitle("Books")
            .searchable(text: $query, prompt: "Search the shelf")
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) {
                if selecting { selectionBar }
            }
            .refreshable { await BookMaster.shared.pullShelf(into: library) }
            // match rows to files when either side changes
            .task(id: library.books.map { "\($0.id)\($0.title)\($0.author)\($0.bookmasterId ?? "")" }.hashValue
                        ^ BookMaster.shared.shelfRows.hashValue) { matchBooks() }
        }
        // the stack, not the list: a pushed pane is still the Books tab
        .onAppear { BookMaster.shared.place = "bookmaster" }
        .onDisappear { BookMaster.shared.place = "library" }
    }

    @ViewBuilder
    private var linkedBody: some View {
        if rows.isEmpty {
            emptyShelf
        } else {
            readingCard
            queueCard
            pickCard
            shelfCard
        }
        destinations
        if let error {
            Label(error, systemImage: "wifi.exclamationmark")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .bmCard()
        }
    }

    private var emptyShelf: some View {
        ContentUnavailableView {
            Label("Nothing on the shelf yet", systemImage: "books.vertical")
        } description: {
            Text("Books you add on BookMaster — or find below — show up here.")
        } actions: {
            Button { pushing = .find } label: { Label("Find a book", systemImage: "magnifyingglass") }
        }
        .padding(.top, 40)
    }

    // MARK: Reading now

    @ViewBuilder
    private var readingCard: some View {
        if !reading.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Reading now").font(.headline)
                    Spacer()
                    Text("\(reading.count)").font(.caption).foregroundStyle(.secondary)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(reading.prefix(8)) { row in
                            Button { open(row) } label: { shelfBook(row) }
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
            BMCover(row: row)
                .aspectRatio(2/3, contentMode: .fit)
                .frame(width: 110)
            Text(row.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            Text(row.author ?? "Unknown author").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if let percent = row.percent {
                ProgressView(value: min(max(percent / 100, 0), 1)).tint(.ptAccent)
            }
        }
        .frame(width: 110, alignment: .leading)
    }

    // MARK: Up next

    @ViewBuilder
    private var queueCard: some View {
        if !queue.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Up next", systemImage: "text.line.first.and.arrowtriangle.forward").font(.headline)
                    Spacer()
                    Text("Tap arrows to reorder").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(queue) { row in
                    HStack(spacing: 10) {
                        Text("\(row.upNext ?? 0)")
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        Button { open(row) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.title).font(.subheadline.weight(.medium)).lineLimit(1)
                                    if let author = row.author {
                                        Text(author).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        stepper(row)
                    }
                }
            }
            .bmCard()
        }
    }

    /// A bump up or down the queue — each move writes, like the web's drag does.
    private func stepper(_ row: BMShelfRow) -> some View {
        HStack(spacing: 2) {
            Button { move(row, by: -1) } label: {
                Image(systemName: "chevron.up").font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(row.id == queue.first?.id)
            Button { move(row, by: 1) } label: {
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(row.id == queue.last?.id)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.ptAccent)
    }

    private func move(_ row: BMShelfRow, by delta: Int) {
        var ids = queue.map(\.userBookId)
        guard let i = ids.firstIndex(of: row.userBookId) else { return }
        let j = i + delta
        guard j >= 0, j < ids.count else { return }
        ids.swapAt(i, j)
        Task {
            do { _ = try await BookMaster.shared.setUpNext(ids) }
            catch { self.error = error.localizedDescription }
        }
    }

    // MARK: Pick for me

    @ViewBuilder
    private var pickCard: some View {
        if !toRead.isEmpty {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Can’t choose?").font(.headline)
                    Text("\(toRead.count) on the to-read pile")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { pick = toRead.randomElement() } label: {
                    Label("Pick for me", systemImage: "dice.fill")
                }
                .buttonStyle(.borderedProminent).tint(.ptAccent)
            }
            .bmCard()
        }
    }

    // MARK: The shelf

    private var shelfCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Show", selection: $filter) {
                ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if visible.isEmpty {
                Text(query.isEmpty ? "Nothing in \(filter.rawValue.lowercased()) yet." : "Nothing matches “\(query)”.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                    ForEach(visible) { row in
                        gridCell(row)
                    }
                }
            }
        }
        .bmCard()
    }

    private func gridCell(_ row: BMShelfRow) -> some View {
        Button {
            if selecting {
                if selected.contains(row.userBookId) { selected.remove(row.userBookId) }
                else { selected.insert(row.userBookId) }
            } else {
                open(row)
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                BMCover(row: row)
                    .aspectRatio(2/3, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .overlay(alignment: .topTrailing) {
                        if selecting {
                            Image(systemName: selected.contains(row.userBookId)
                                  ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(Color.ptAccent, .white)
                                .padding(6)
                        } else if local(row) != nil {
                            Image(systemName: "iphone")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(5)
                                .background(Color.ptAccent, in: Circle())
                                .padding(5)
                        }
                    }
                Text(row.title).font(.caption.weight(.medium)).lineLimit(2)
                HStack(spacing: 4) {
                    Text(BMShelf.label(forStatus: row.status))
                    if row.status == "reading", let percent = row.percent {
                        Text("· \(Int(percent.rounded()))%")
                    }
                }
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Destinations

    private var destinations: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("More of BookMaster").font(.headline)
            destinationRow("What to read next", "sparkles", .orange) { pushing = .discover }
            destinationRow("Quotes & notes", "quote.bubble.fill", .purple) { pushing = .quotes }
            destinationRow("Series", "books.vertical.fill", .green) { pushing = .series }
            destinationRow("Find or add a book", "magnifyingglass", .blue) { pushing = .find }
            destinationRow("The year so far", "calendar", .pink) { pushing = .wrapped }
        }
    }

    private func destinationRow(_ title: String, _ icon: String, _ color: Color,
                                action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.headline).foregroundStyle(color)
                    .frame(width: 32, height: 32)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(title).font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.primary)
            .padding(12)
            .background(Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: Toolbar & selection

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                let all = selected.count == visible.count && !visible.isEmpty
                Button(all ? "Deselect All" : "Select All") {
                    selected = all ? [] : Set(visible.map(\.userBookId))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { selecting = false; selected = [] }
                    .fontWeight(.semibold)
            }
        } else {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Sort", selection: $sort) {
                        ForEach(Sort.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
                .accessibilityLabel("Sort shelf")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { pushing = .find } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Find or add a book")
            }
            if !rows.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { selecting = true } label: { Image(systemName: "checkmark.circle") }
                        .accessibilityLabel("Select books")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { router.showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
    }

    /// The select-mode bar — a status change or an unshelve for every tick.
    private var selectionBar: some View {
        HStack(spacing: 4) {
            barButton("To read", "bookmark") { bulk(status: "want_to_read") }
            barButton("Reading", "book") { bulk(status: "reading") }
            barButton("Finished", "checkmark") { bulk(status: "read") }
            barButton("Remove", "trash") { bulkUnshelve() }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .ptGlassCapsule()
        .padding(.bottom, 6)
        .disabled(selected.isEmpty)
    }

    private func barButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(.system(size: 18, weight: .medium))
                Text(title).font(.caption2)
            }
            .frame(minWidth: 72, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func bulk(status: String) {
        let pins = Array(selected)
        Task {
            for pin in pins {
                do { _ = try await BookMaster.shared.shelve(pin: pin, status: BMShelfStatus(rawValue: status)) }
                catch { self.error = error.localizedDescription }
            }
            selecting = false
            selected = []
        }
    }

    private func bulkUnshelve() {
        let pins = Array(selected)
        Task {
            for pin in pins {
                do { _ = try await BookMaster.shared.shelve(pin: pin, unshelve: true) }
                catch { self.error = error.localizedDescription }
            }
            selecting = false
            selected = []
        }
    }

    /// A row's destination: its file when it lives here, the detail pane otherwise.
    private func open(_ row: BMShelfRow) {
        if let book = local(row) {
            router.open(book, library: library)
        } else {
            pick = row
        }
    }
}
