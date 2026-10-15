import SwiftUI

/// The catalogue row's facts — the web's "Edit book" form. Only reachable for
/// a book on your shelf; a new cover URL wins only when "use this jacket" is
/// asked for, so a pushed cover is never lost by accident.
struct BMEditSheet: View {
    let bookId: String
    var detail: BMBookDetail?
    var onDone: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var author = ""
    @State private var pages = ""
    @State private var year = ""
    @State private var isbn = ""
    @State private var cover = ""
    @State private var coverPick = false
    @State private var genres = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("The book") {
                    TextField("Title", text: $title)
                    TextField("Author", text: $author)
                    TextField("Total pages", text: $pages).keyboardType(.numberPad)
                    TextField("Published year", text: $year).keyboardType(.numberPad)
                    TextField("ISBN", text: $isbn).keyboardType(.numbersAndPunctuation)
                }
                Section("Jacket") {
                    TextField("Cover image URL", text: $cover)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !cover.isEmpty {
                        Toggle("Use this jacket even over a pushed one", isOn: $coverPick)
                    }
                }
                Section {
                    TextField("Genres, comma-separated", text: $genres)
                } footer: {
                    Text("Shrinking the page count folds your bookmark in with it.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Edit book")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { prefill() }
        }
    }

    private func prefill() {
        let c = detail?.catalogue
        let b = detail?.book
        title = c?.title ?? b?.title ?? ""
        author = c?.author ?? b?.author ?? ""
        pages = (c?.totalPages ?? b?.totalPages).map(String.init) ?? ""
        year = (c?.publishedYear ?? b?.publishedYear).map(String.init) ?? ""
        isbn = c?.isbn ?? b?.isbn ?? ""
        cover = c?.coverUrl ?? ""
        genres = c?.genreList.joined(separator: ", ") ?? ""
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await BookMaster.shared.editBook(
                bookId,
                title: title.trimmingCharacters(in: .whitespaces),
                author: author.trimmingCharacters(in: .whitespaces),
                totalPages: Int(pages),
                publishedYear: Int(year),
                isbn: isbn.trimmingCharacters(in: .whitespaces).isEmpty ? nil : isbn,
                genres: genres.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty },
                coverUrl: cover.trimmingCharacters(in: .whitespaces).isEmpty ? nil : cover,
                coverPick: coverPick)
            onDone()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
