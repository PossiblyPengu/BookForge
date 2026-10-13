import SwiftUI

/// BookMaster's own catalogue search — the shelf first, then Open Library —
/// with every hit one tap from your shelf. The Find page of the tab.
struct BookMasterSearchView: View {
    /// A lane carried in from Discover — the field starts filled.
    var starting: String = ""

    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    @State private var query = ""
    @State private var results: [BMSearchBook] = []
    @State private var searching = false
    @State private var info: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            if results.isEmpty, !searching, !query.isEmpty {
                ContentUnavailableView(
                    "No matches", systemImage: "magnifyingglass",
                    description: Text("Nothing on the shelf or in Open Library by that name."))
                    .listRowBackground(Color.clear)
            }
            ForEach(results, id: \.stableKey) { hit in
                row(hit)
            }
            if searching {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let info { Section { Text(info).foregroundStyle(.secondary) } }
            if let error { Section { Text(error).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Find a book")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Title or author")
        .onSubmit(of: .search) { Task { await search() } }
        .onChange(of: query) { _, q in
            if q.isEmpty { results = [] }
            else { Task { await search() } }
        }
        .onAppear {
            if query.isEmpty, !starting.isEmpty {
                query = starting
            }
        }
    }

    /// One hit: the shelf state when it is already yours, or the ways to add it.
    private func row(_ hit: BMSearchBook) -> some View {
        HStack(spacing: 12) {
            AsyncImage(url: coverURL(hit)) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Color.secondary.opacity(0.15).overlay(
                        Image(systemName: "book.closed").foregroundStyle(.secondary))
                }
            }
            .frame(width: 40, height: 60)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(hit.title).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    if let author = hit.author, !author.isEmpty { Text(author) }
                    if let year = hit.year { Text("· \(year)") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let status = hit.status {
                    Text(BMShelf.label(forStatus: status))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.ptAccent)
                }
            }
            Spacer()
            actions(hit)
        }
    }

    /// Already on the shelf → its page; not → the Add menu.
    @ViewBuilder
    private func actions(_ hit: BMSearchBook) -> some View {
        if let pin = hit.userBookId {
            NavigationLink { BookMasterDetailView(pin: pin) } label: {
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
        } else {
            Menu {
                ForEach(BMShelfStatus.allCases) { s in
                    Button(s.label) { Task { await add(hit, as: s) } }
                }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.ptAccent)
            }
            .disabled(busy)
        }
    }

    /// The jacket the hit names: its own URL, then Open Library's.
    private func coverURL(_ hit: BMSearchBook) -> URL? {
        if let cover = hit.coverUrl, let url = URL(string: cover) { return url }
        return bmCoverURL(isbn: hit.isbn, openLibraryId: hit.openLibraryId)
    }

    private func search() async {
        let name = query.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { results = []; return }
        searching = true
        defer { searching = false }
        results = await BookMaster.shared.searchCatalogue(title: name, author: "")
    }

    /// Shelve a find, annotated with the catalogue facts it carried.
    private func add(_ hit: BMSearchBook, as status: BMShelfStatus) async {
        busy = true
        defer { busy = false }
        do {
            var extra: [String: Any] = [:]
            if let pages = hit.totalPages { extra["total_pages"] = pages }
            if let cover = hit.coverUrl { extra["cover_url"] = cover }
            _ = try await BookMaster.shared.shelve(
                ref: BMBookRef(
                    title: hit.title,
                    author: hit.author ?? "",
                    isbn: hit.isbn,
                    openLibraryId: hit.openLibraryId,
                    userBookId: nil),
                status: status,
                extra: extra)
            info = "“\(hit.title)” is on your \(status.label.lowercased()) shelf."
            error = nil
            await search()
        } catch {
            self.error = error.localizedDescription
            info = nil
        }
    }
}

private extension BMSearchBook {
    /// One result among lookalikes: its catalogue id when it has one.
    var stableKey: String {
        bookId ?? userBookId ?? openLibraryId ?? isbn ?? "\(title)|\(author ?? "")"
    }
}
