import SwiftUI

/// Search across the whole library. On iOS 26 the field lives in the tab bar.
struct SearchTab: View {
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router
    @State private var query = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                let results = library.sortedBooks(order: .recent, query: query)
                if library.books.isEmpty {
                    ContentUnavailableView {
                        Label("No Books Yet", systemImage: "books.vertical")
                    } description: {
                        Text("Nothing to search until a book is in the library.")
                    } actions: {
                        Button { router.showImporter = true } label: {
                            Label("Add Books", systemImage: "plus")
                        }
                    }
                    .padding(.top, 60)
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .padding(.top, 60)
                } else {
                    BookGrid(books: results)
                        .padding(18)
                }
            }
            .ptSoftScrollEdges()
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Books and audiobooks")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { router.showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
    }
}
