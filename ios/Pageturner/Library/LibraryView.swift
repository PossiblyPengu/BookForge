import SwiftUI
import UniformTypeIdentifiers

/// The library tab: pick up where you left off, then the shelf.
struct LibraryView: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    @State private var showImporter = false
    @State private var filter: Filter = .all
    @AppStorage("librarySort") private var sortOrder = LibraryStore.SortOrder.recent.rawValue
    @AppStorage("libraryShelf") private var shelfKey = LibraryView.allKey

    // select mode
    @State private var selecting = false
    @State private var selected: Set<UUID> = []
    @State private var finding: (done: Int, total: Int)?
    @State private var findResult: String?

    /// Comics and Markdown have no system type everywhere — match them by extension.
    private static let extraTypes = ["cbz", "md", "markdown"].compactMap { UTType(filenameExtension: $0) }
    private static let pickerTypes: [UTType] = [.epub, .pdf, .audio, .plainText, .html, .zip] + extraTypes

    /// Built-in shelf filters carry a "~" a shelf name can't start with.
    private static let allKey = "~all"
    private static let upNextKey = "~upnext"

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", books = "Books", audiobooks = "Audiobooks"
        var id: String { rawValue }
    }

    private var order: LibraryStore.SortOrder {
        LibraryStore.SortOrder(rawValue: sortOrder) ?? .recent
    }

    private var shelfKeys: [String] {
        let upNext = library.books.contains { $0.bmUpNext == true }
        return [Self.allKey] + (upNext ? [Self.upNextKey] : []) + library.shelves
    }

    /// The chosen shelf, unless it has since been deleted or emptied of its reason to exist.
    private var activeShelfKey: String {
        shelfKeys.contains(shelfKey) ? shelfKey : Self.allKey
    }

    private func shelfLabel(_ key: String) -> String {
        switch key {
        case Self.allKey: return "All"
        case Self.upNextKey: return "Up next"
        default: return key
        }
    }

    private var visible: [Book] {
        var list = library.sortedBooks(order: order, query: "")
        switch activeShelfKey {
        case Self.allKey: break
        case Self.upNextKey: list = list.filter { $0.bmUpNext == true }
        default: list = list.filter { $0.collections.contains(activeShelfKey) }
        }
        switch filter {
        case .all: return list
        case .books: return list.filter { !$0.isAudio }
        case .audiobooks: return list.filter { $0.isAudio }
        }
    }

    private var continueBook: Book? { library.continueBook }

    var body: some View {
        NavigationStack {
            Group {
                if library.books.isEmpty {
                    emptyState
                } else {
                    content
                }
            }
            .navigationTitle(selecting ? "\(selected.count) Selected" : "Library")
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) {
                if selecting { selectionBar }
            }
            .overlay { if let finding { findingCard(finding) } }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: Self.pickerTypes,
                allowsMultipleSelection: true
            ) { result in
                if case let .success(urls) = result {
                    Task { await library.importFiles(urls) }
                }
            }
            .alert("Import problem", isPresented: Binding(
                get: { library.lastError != nil },
                set: { if !$0 { library.lastError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(library.lastError ?? "")
            }
            .alert("Find Details", isPresented: Binding(
                get: { findResult != nil },
                set: { if !$0 { findResult = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(findResult ?? "")
            }
            // books removed elsewhere (the confirmation lives at the root) drop out of the selection
            .onChange(of: library.books) { _, books in
                selected = selected.intersection(Set(books.map(\.id)))
                if books.isEmpty { selecting = false }
            }
        }
    }

    // MARK: Content

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if !selecting, let book = continueBook {
                    ContinueCard(book: book, cover: library.cover(for: book)) {
                        router.open(book, library: library)
                    }
                }
                Picker("Show", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if !selecting { shelfChips }

                if visible.isEmpty {
                    ContentUnavailableView(
                        filter == .audiobooks ? "No Audiobooks" : "No Books",
                        systemImage: filter == .audiobooks ? "headphones" : "book.closed")
                        .padding(.top, 40)
                } else {
                    BookGrid(books: visible, selection: selecting ? $selected : nil)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 24)
        }
        .ptSoftScrollEdges()
    }

    /// "All", "Up next" (books BookMaster has queued) and the reader's own shelves.
    @ViewBuilder
    private var shelfChips: some View {
        if shelfKeys.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(shelfKeys, id: \.self) { key in
                        let active = key == activeShelfKey
                        Button { shelfKey = key } label: {
                            Text(shelfLabel(key))
                                .font(.subheadline.weight(.medium))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 7)
                                .background(active ? Color.ptAccent : Color(.tertiarySystemFill), in: Capsule())
                                .foregroundStyle(active ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(active ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Books Yet", systemImage: "books.vertical")
        } description: {
            Text("Add EPUB, PDF, CBZ comic, text or audiobook files (or a zip of them) from Files, or use “Open in Pageturner” from another app.")
        } actions: {
            Button { showImporter = true } label: {
                Label("Add Books", systemImage: "plus")
            }
            .ptButtonStyle(prominent: true)
            Button { router.showSettings = true } label: {
                Text("Watch a folder in Settings")
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                let all = selected.count == visible.count && !visible.isEmpty
                Button(all ? "Deselect All" : "Select All") {
                    selected = all ? [] : Set(visible.map(\.id))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    selecting = false
                    selected = []
                }
                .fontWeight(.semibold)
            }
        } else {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Sort", selection: $sortOrder) {
                        ForEach(LibraryStore.SortOrder.allCases) { o in
                            Text(o.label).tag(o.rawValue)
                        }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
                .accessibilityLabel("Sort books")
            }
            if !library.books.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { selecting = true } label: {
                        Image(systemName: "checkmark.circle")
                    }
                    .accessibilityLabel("Select books")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showImporter = true } label: {
                    if library.importing { ProgressView() } else { Image(systemName: "plus") }
                }
                .disabled(library.importing)
                .accessibilityLabel("Add books")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { router.showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
    }

    // MARK: Select mode

    private var selectionBar: some View {
        HStack(spacing: 4) {
            barButton("Shelves", "books.vertical") { router.openShelves(Array(selected)) }
            barButton("Find Details", "sparkle.magnifyingglass") { findDetails() }
            barButton("Remove", "trash") {
                router.askDelete(library.books.filter { selected.contains($0.id) })
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .ptGlassCapsule()
        .padding(.bottom, 6)
        .disabled(selected.isEmpty || finding != nil)
    }

    private func barButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(.system(size: 18, weight: .medium))
                Text(title).font(.caption2)
            }
            .frame(minWidth: 84, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Look each ticked book up online and fill in what it's missing.
    private func findDetails() {
        let ids = Array(selected)
        guard !ids.isEmpty else { return }
        finding = (0, ids.count)
        Task {
            var updated = 0
            for (n, id) in ids.enumerated() {
                if await MetadataLookup.autoApply(to: id, library: library) { updated += 1 }
                finding = (n + 1, ids.count)
            }
            finding = nil
            findResult = updated == 0
                ? "No new details turned up for \(ids.count == 1 ? "that book" : "those books")."
                : "Updated \(updated) of \(ids.count) book\(ids.count == 1 ? "" : "s")."
        }
    }

    private func findingCard(_ progress: (done: Int, total: Int)) -> some View {
        VStack(spacing: 10) {
            ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                .tint(.ptAccent)
            Text("Finding details… \(progress.done) of \(progress.total)")
                .font(.subheadline)
        }
        .padding(20)
        .frame(maxWidth: 280)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .transition(.opacity)
    }
}

/// "Continue reading" — the cover, how far along you are, and one button.
private struct ContinueCard: View {
    let book: Book
    let cover: UIImage?
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // beside the cover normally; under it when the text is large enough to need the width
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
        layout {
            BookCoverView(book: book, cover: cover, showsBadges: false, corner: 8)
                .frame(width: typeSize.isAccessibilitySize ? 110 : 84)
            VStack(alignment: .leading, spacing: 6) {
                Text(book.isAudio ? "Keep listening" : "Continue reading")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.ptAccent)
                    .textCase(.uppercase)
                Text(book.title)
                    .font(.headline)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                if !book.author.isEmpty {
                    Text(book.author)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                }
                ProgressView(value: min(max(book.progression ?? 0, 0), 1))
                    .tint(.ptAccent)
                    .padding(.top, 2)
                Button(action: action) {
                    Label(book.isAudio ? "Play" : "Read", systemImage: book.isAudio ? "play.fill" : "book.fill")
                        .font(.subheadline.weight(.semibold))
                }
                .ptButtonStyle(prominent: true)
                .controlSize(.small)
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.ptAccent.opacity(0.12), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}
