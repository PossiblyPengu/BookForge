import SwiftUI

/// The reader's whole BookMaster shelf — paper books, things read elsewhere, and the ones with a file here.
/// Pageturner's library is the files it reads; BookMaster can hold any book, so a row without a file is
/// normal. A book that is in the library says so and opens; any other shows where it stands on BookMaster,
/// with an optional way to add its file.
struct BookMasterShelfView: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    @State private var chosen: BMShelfRow?

    private var groups: [BMShelf.Group] { BMShelf.groups(BookMaster.shared.shelfRows) }

    /// The book in the library that is this shelf row, if any.
    private func local(_ row: BMShelfRow) -> Book? {
        library.books.first { BMShelf.match($0, in: [row]) != nil }
    }

    var body: some View {
        List {
            if groups.isEmpty {
                ContentUnavailableView(
                    "Nothing on the shelf yet", systemImage: "books.vertical",
                    description: Text("Books you add on BookMaster show up here."))
                    .listRowBackground(Color.clear)
            }
            ForEach(groups) { group in
                Section(group.title) {
                    ForEach(group.rows) { row in
                        let book = local(row)
                        Button {
                            if let book { router.open(book, library: library) } else { chosen = row }
                        } label: { ShelfRowView(row: row, inLibrary: book != nil) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("Your Shelf")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await BookMaster.shared.pullShelf(into: library) }
        .sheet(item: $chosen) { ShelfBookSheet(row: $0) }
    }
}

private struct ShelfRowView: View {
    let row: BMShelfRow
    let inLibrary: Bool

    var body: some View {
        HStack(spacing: 12) {
            ShelfCover(row: row).frame(width: 44, height: 66)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).font(.body.weight(.medium)).lineLimit(2)
                if let author = row.author, !author.isEmpty {
                    Text(author).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 6) {
                    Text(BMShelf.label(forStatus: row.status))
                    if row.status == "reading", let percent = row.percent { Text("· \(Int(percent.rounded()))%") }
                    if let rating = row.rating, rating > 0 { Text(String(repeating: "★", count: min(rating, 5))) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if inLibrary {
                Label("In library", systemImage: "iphone").labelStyle(.iconOnly).foregroundStyle(Color.ptAccent)
                    .accessibilityLabel("In your library")
            }
        }
        .contentShape(Rectangle())
    }
}

private struct ShelfCover: View {
    let row: BMShelfRow

    var body: some View {
        AsyncImage(url: row.coverURL) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.15).overlay(
                    Image(systemName: row.isAudio ? "headphones" : "book.closed").foregroundStyle(.secondary))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

/// A shelf book with no file here: where it stands on BookMaster, and a way to bring its file in.
private struct ShelfBookSheet: View {
    let row: BMShelfRow
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        ShelfCover(row: row).frame(width: 64, height: 96)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title).font(.headline)
                            if let author = row.author, !author.isEmpty { Text(author).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section("Where it stands") {
                    LabeledContent("Status", value: BMShelf.label(forStatus: row.status) + (row.upNext != nil ? " · up next" : ""))
                    if let percent = row.percent { LabeledContent("Position", value: "\(Int(percent.rounded()))%") }
                    if let rating = row.rating, rating > 0 {
                        LabeledContent("Rating", value: String(repeating: "★", count: min(rating, 5)))
                    }
                    if row.isAudio { LabeledContent("Format", value: "Audiobook") }
                }
                Section {
                    Button { importing = true } label: { Label("Add a File to Read Here…", systemImage: "square.and.arrow.down") }
                } footer: {
                    Text("Optional. This book is on your shelf without a file in Pageturner — a paper copy, or read elsewhere. If you have the EPUB, PDF or audio, add it and Pageturner ties it to this shelf entry so your place and rating stay in step.")
                }
            }
            .navigationTitle("On BookMaster")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .fileImporter(isPresented: $importing, allowedContentTypes: LibraryView.pickerTypes, allowsMultipleSelection: true) { result in
                guard case let .success(urls) = result else { return }
                Task { await bringIn(urls) }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Import, and when that made exactly one new book, tie it to this row whatever its file says it is called.
    private func bringIn(_ urls: [URL]) async {
        let before = Set(library.books.map(\.id))
        await library.importFiles(urls)
        let added = library.books.filter { !before.contains($0.id) }
        if added.count == 1 {
            let pin = row.userBookId
            library.updateBookMaster(added[0].id) { $0.bookmasterId = pin }
        }
        await BookMaster.shared.pullShelf(into: library)
        dismiss()
    }
}
