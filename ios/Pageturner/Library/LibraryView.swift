import SwiftUI
import UniformTypeIdentifiers

struct LibraryView: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var showImporter = false
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
            Group {
                if library.books.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 24) {
                            ForEach(library.sortedBooks(order: order, query: query)) { book in
                                Button { openBook = book } label: {
                                    BookCell(book: book, cover: library.cover(for: book))
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
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
                            }
                        }
                        .padding(18)
                    }
                    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic))
                }
            }
            .navigationTitle("Library")
            .toolbar {
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
                    Button { showImporter = true } label: {
                        if library.importing { ProgressView() } else { Image(systemName: "plus") }
                    }
                    .disabled(library.importing)
                    .accessibilityLabel("Add books")
                }
            }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [.epub, .pdf, .audio],
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
    private let original: Book
    private let onSave: (Book) -> Void
    @Environment(\.dismiss) private var dismiss

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
            }
            .navigationTitle("Edit Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var book = original
                        book.title = title.trimmingCharacters(in: .whitespaces)
                        book.author = author.trimmingCharacters(in: .whitespaces)
                        onSave(book)
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
