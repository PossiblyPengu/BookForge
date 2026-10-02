import SwiftUI
import UniformTypeIdentifiers

struct LibraryView: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var showImporter = false
    @State private var showBackupImporter = false
    @State private var shareItem: ShareItem?
    @State private var backupMessage: String?
    @State private var openBook: Book?
    @State private var detailBook: Book?
    @State private var editBook: Book?
    @State private var query = ""
    @AppStorage("librarySort") private var sortOrder = LibraryStore.SortOrder.recent.rawValue

    private let columns = [GridItem(.adaptive(minimum: 104, maximum: 160), spacing: 18)]

    private var order: LibraryStore.SortOrder {
        LibraryStore.SortOrder(rawValue: sortOrder) ?? .recent
    }

    var body: some View {
        NavigationStack {
            libraryContent
                .navigationTitle("Library")
                .toolbar { toolbar }
                .fileImporter(
                    isPresented: $showImporter,
                    allowedContentTypes: [.epub, .pdf, .audio],
                    allowsMultipleSelection: true
                ) { result in
                    if case let .success(urls) = result {
                        Task { await library.importFiles(urls) }
                    }
                }
                .fileImporter(
                    isPresented: $showBackupImporter,
                    allowedContentTypes: [.zip]
                ) { result in
                    if case let .success(urls) = result, let url = urls.first {
                        restoreBackup(url)
                    }
                }
                .sheet(item: $shareItem) { ShareSheet(items: [$0.url]) }
                .alert("Backup", isPresented: Binding(
                    get: { backupMessage != nil },
                    set: { if !$0 { backupMessage = nil } }
                )) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(backupMessage ?? "")
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
        .fullScreenCover(item: $openBook) { book in
            if book.isAudio {
                AudioPlayerView(book: book, library: library)
            } else {
                ReaderView(book: book, library: library)
            }
        }
        .sheet(item: $detailBook) { book in
            BookDetailSheet(book: book, cover: library.cover(for: book)) {
                detailBook = nil
                openBook = book
            } onEdit: {
                detailBook = nil
                // present the edit sheet after this one is fully dismissed
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { editBook = book }
            } onDelete: {
                library.delete(book)
                detailBook = nil
            }
        }
        .sheet(item: $editBook) { book in
            BookEditSheet(book: book) { updated in
                library.update(updated)
                editBook = nil
            }
        }
    }

    @ViewBuilder
    private var libraryContent: some View {
        if library.books.isEmpty {
            emptyState
        } else {
            libraryGrid
        }
    }

    private var libraryGrid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 24) {
                ForEach(library.sortedBooks(order: order, query: query)) { book in
                    Button { openBook = book } label: {
                        BookCell(book: book, cover: library.cover(for: book))
                    }
                    .buttonStyle(.plain)
                    .contextMenu { bookMenu(for: book) }
                }
            }
            .padding(18)
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic))
    }

    @ViewBuilder
    private func bookMenu(for book: Book) -> some View {
        Button { detailBook = book } label: {
            Label("Book Info", systemImage: "info.circle")
        }
        Button { editBook = book } label: {
            Label("Edit Details", systemImage: "pencil")
        }
        Divider()
        Button(role: .destructive) { library.delete(book) } label: {
            Label("Remove from Library", systemImage: "trash")
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
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
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button { exportBackup() } label: {
                    Label("Export Library Backup", systemImage: "square.and.arrow.up")
                }
                Button { showBackupImporter = true } label: {
                    Label("Restore Backup…", systemImage: "square.and.arrow.down")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Backup options")
        }
        ToolbarItem(placement: .primaryAction) {
            Button { showImporter = true } label: {
                if library.importing { ProgressView() } else { Image(systemName: "plus") }
            }
            .disabled(library.importing)
            .accessibilityLabel("Add books")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "books.vertical")
                .font(.system(size: 52))
                .foregroundStyle(.secondary)
            Text("No books yet").font(.title3.weight(.semibold))
            Text("Add EPUB, PDF, or audiobook files from Files, or use “Open in Pageturner” from another app.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button { showImporter = true } label: {
                Label("Add Books", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 6)
        }
    }

    private func exportBackup() {
        backupMessage = nil
        Task {
            do {
                let url = try await BackupStore(library: library).exportBackup()
                shareItem = ShareItem(url: url)
            } catch {
                backupMessage = error.localizedDescription
            }
        }
    }

    private func restoreBackup(_ url: URL) {
        backupMessage = nil
        Task {
            do {
                let r = try await BackupStore(library: library).importBackup(url)
                backupMessage = "Restored \(r.restored) book\(r.restored == 1 ? "" : "s")"
                    + (r.skipped > 0 ? " · skipped \(r.skipped)" : "")
            } catch {
                backupMessage = error.localizedDescription
            }
        }
    }
}

/// Wraps a URL so `.sheet(item:)` can present the share sheet.
private struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// `UIActivityViewController` for handing the backup zip to Files/AirDrop/etc.
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

private struct BookCell: View {
    let book: Book
    let cover: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                if let cover {
                    Image(uiImage: cover).resizable().scaledToFill()
                } else {
                    LinearGradient(colors: [.orange.opacity(0.7), .brown], startPoint: .top, endPoint: .bottom)
                    Text(book.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(8)
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(2 / 3, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .shadow(color: .black.opacity(0.25), radius: 4, y: 2)

            Text(book.title)
                .font(.footnote.weight(.medium))
                .lineLimit(2)
            HStack {
                Text(book.author).lineLimit(1)
                Spacer(minLength: 4)
                if let p = book.progression, p > 0 {
                    Text("\(Int((p * 100).rounded()))%").monospacedDigit()
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }
}

private struct BookDetailSheet: View {
    let book: Book
    let cover: UIImage?
    let onOpen: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 16) {
                        Group {
                            if let cover {
                                Image(uiImage: cover).resizable().scaledToFill()
                            } else {
                                ZStack {
                                    LinearGradient(colors: [.orange.opacity(0.7), .brown], startPoint: .top, endPoint: .bottom)
                                    Text(book.title).font(.caption.weight(.semibold)).foregroundStyle(.white)
                                        .multilineTextAlignment(.center).padding(6)
                                }
                            }
                        }
                        .frame(width: 84, height: 126)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(book.title).font(.headline)
                            if !book.author.isEmpty {
                                Text(book.author).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                Section {
                    LabeledContent("File", value: book.fileName)
                    LabeledContent("Added", value: book.addedAt.formatted(date: .abbreviated, time: .omitted))
                    if let opened = book.lastOpenedAt {
                        LabeledContent("Last opened", value: opened.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let p = book.progression {
                        LabeledContent("Progress", value: "\(Int((p * 100).rounded()))%")
                    }
                    if book.isAudio, book.fileNames.count > 1 {
                        LabeledContent("Tracks", value: "\(book.fileNames.count)")
                    }
                    if !book.isAudio {
                        LabeledContent("Bookmarks", value: "\(book.bookmarks.count)")
                    }
                }
                Section {
                    Button("Open Book", action: onOpen)
                    Button("Edit Details", action: onEdit)
                    Button("Remove from Library", role: .destructive, action: onDelete)
                }
            }
            .navigationTitle("Book Info")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}

private struct BookEditSheet: View {
    @State private var title: String
    @State private var author: String
    @State private var searching = false
    @State private var candidates: [MetadataCandidate]?
    @State private var pickedCover: URL?
    private let original: Book
    private let onSave: (Book) -> Void
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var library: LibraryStore

    init(book: Book, onSave: @escaping (Book) -> Void) {
        _title = State(initialValue: book.title)
        _author = State(initialValue: book.author)
        original = book
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Author", text: $author)

                Section("Lookup") {
                    if searching {
                        HStack {
                            ProgressView()
                            Text("Searching Google Books + Open Library…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Find Metadata Online") { lookup() }
                    }
                    if let candidates {
                        if candidates.isEmpty {
                            Text("No matches found.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(candidates) { c in
                            Button { apply(c) } label: {
                                HStack(spacing: 10) {
                                    AsyncImage(url: c.coverURL) { image in
                                        image.resizable().scaledToFill()
                                    } placeholder: {
                                        Image(systemName: "book.closed")
                                            .foregroundStyle(.secondary)
                                    }
                                    .frame(width: 34, height: 50)
                                    .clipShape(RoundedRectangle(cornerRadius: 4))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(c.title).font(.subheadline.weight(.medium)).lineLimit(2)
                                        Text(c.authors).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                        Text([c.year, c.source].filter { !$0.isEmpty }.joined(separator: " · "))
                                            .font(.caption2).foregroundStyle(.tertiary)
                                    }
                                    Spacer()
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }
            }
            .navigationTitle("Edit Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func lookup() {
        searching = true
        candidates = nil
        Task {
            let results = await MetadataLookup.search(title: title, author: author)
            await MainActor.run {
                candidates = results
                searching = false
            }
        }
    }

    private func apply(_ candidate: MetadataCandidate) {
        title = candidate.title
        author = candidate.authors
        pickedCover = candidate.coverURL
    }

    private func save() {
        var book = original
        book.title = title.trimmingCharacters(in: .whitespaces)
        book.author = author.trimmingCharacters(in: .whitespaces)
        onSave(book)
        if let pickedCover {
            Task { await MetadataLookup.applyCover(from: pickedCover, to: book, library: library) }
        }
    }
}
