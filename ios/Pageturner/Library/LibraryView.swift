import SwiftUI
import UniformTypeIdentifiers

/// The library tab: pick up where you left off, then the shelf.
struct LibraryView: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    @State private var showImporter = false
    @State private var filter: Filter = .all
    @AppStorage("librarySort") private var sortOrder = LibraryStore.SortOrder.recent.rawValue

    /// Comic archives have no system type — match them by extension.
    private static let comicTypes = ["cbz"].compactMap { UTType(filenameExtension: $0) }

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", books = "Books", audiobooks = "Audiobooks"
        var id: String { rawValue }
    }

    private var order: LibraryStore.SortOrder {
        LibraryStore.SortOrder(rawValue: sortOrder) ?? .recent
    }

    private var shelf: [Book] {
        let sorted = library.sortedBooks(order: order, query: "")
        switch filter {
        case .all: return sorted
        case .books: return sorted.filter { !$0.isAudio }
        case .audiobooks: return sorted.filter { $0.isAudio }
        }
    }

    /// The book most recently opened that isn't finished.
    private var continueBook: Book? {
        library.books
            .filter { ($0.progression ?? 0) > 0.001 && ($0.progression ?? 0) < 0.995 }
            .max { ($0.lastOpenedAt ?? .distantPast) < ($1.lastOpenedAt ?? .distantPast) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if library.books.isEmpty {
                    emptyState
                } else {
                    content
                }
            }
            .navigationTitle("Library")
            .toolbar { toolbar }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [.epub, .pdf, .audio] + Self.comicTypes,
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
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let book = continueBook {
                    ContinueCard(book: book, cover: library.cover(for: book)) {
                        router.open(book, library: library)
                    }
                }
                Picker("Show", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if shelf.isEmpty {
                    ContentUnavailableView(
                        filter == .audiobooks ? "No Audiobooks" : "No Books",
                        systemImage: filter == .audiobooks ? "headphones" : "book.closed")
                        .padding(.top, 40)
                } else {
                    BookGrid(books: shelf)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 24)
        }
        .ptSoftScrollEdges()
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Books Yet", systemImage: "books.vertical")
        } description: {
            Text("Add EPUB, PDF, CBZ comic or audiobook files from Files, or use “Open in Pageturner” from another app.")
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

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
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

/// "Continue reading" — the cover, how far along you are, and one button.
private struct ContinueCard: View {
    let book: Book
    let cover: UIImage?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            BookCoverView(book: book, cover: cover, showsBadges: false, corner: 8)
                .frame(width: 84)
            VStack(alignment: .leading, spacing: 6) {
                Text(book.isAudio ? "Keep listening" : "Continue reading")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.ptAccent)
                    .textCase(.uppercase)
                Text(book.title)
                    .font(.headline)
                    .lineLimit(2)
                if !book.author.isEmpty {
                    Text(book.author)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
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
