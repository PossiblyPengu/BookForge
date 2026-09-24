import SwiftUI
import UniformTypeIdentifiers

struct LibraryView: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var showImporter = false
    @State private var openBook: Book?

    private let columns = [GridItem(.adaptive(minimum: 104, maximum: 160), spacing: 18)]

    var body: some View {
        NavigationStack {
            Group {
                if library.books.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 24) {
                            ForEach(library.sortedBooks) { book in
                                Button { openBook = book } label: {
                                    BookCell(book: book, cover: library.cover(for: book))
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button(role: .destructive) { library.delete(book) } label: {
                                        Label("Remove from Library", systemImage: "trash")
                                    }
                                }
                            }
                        }
                        .padding(18)
                    }
                }
            }
            .navigationTitle("Library")
            .toolbar {
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
                allowedContentTypes: [.epub, .pdf],
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
            ReaderView(book: book, library: library)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "books.vertical")
                .font(.system(size: 52))
                .foregroundStyle(.secondary)
            Text("No books yet").font(.title3.weight(.semibold))
            Text("Add EPUB or PDF files from Files, or use “Open in Pageturner” from another app.")
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
