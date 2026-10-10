import SwiftUI

struct BookDetailSheet: View {
    let book: Book
    let cover: UIImage?
    let onOpen: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    @State private var showNotes = false
    @State private var tint: Color = .ptAccent

    private var openLabel: String {
        let p = book.progression ?? 0
        if p > 0.001, p < 0.995 { return book.isAudio ? "Continue Listening" : "Continue Reading" }
        return book.isAudio ? "Listen" : "Read"
    }

    /// The cover's colour fading into the sheet, so the page belongs to the book.
    private var backdrop: some View {
        LinearGradient(
            colors: [tint.opacity(0.35), Color(.systemGroupedBackground)],
            startPoint: .top, endPoint: .center
        )
        .ignoresSafeArea()
    }

    private static func statusLabel(_ status: String) -> String {
        switch status {
        case "reading": return "Reading"
        case "read": return "Read"
        case "want_to_read": return "Want to read"
        case "dnf": return "Didn’t finish"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(spacing: 14) {
                        BookCoverView(book: book, cover: cover, showsBadges: false, corner: 12)
                            .frame(width: 150)
                        VStack(spacing: 4) {
                            Text(book.title)
                                .font(.title3.weight(.bold))
                                .multilineTextAlignment(.center)
                            if !book.author.isEmpty {
                                Text(book.author)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Button(action: onOpen) {
                            Label(openLabel, systemImage: book.isAudio ? "play.fill" : "book.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .ptButtonStyle(prominent: true)
                        .controlSize(.large)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
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
                    if let status = book.bmStatus {
                        LabeledContent("On BookMaster", value: Self.statusLabel(status)
                            + (book.bmUpNext == true ? " · up next" : ""))
                    }
                    if let remote = book.bmRemotePercent {
                        LabeledContent("BookMaster position", value: "\(Int(remote.rounded()))%")
                    }
                    if let rating = book.bmRating {
                        LabeledContent("Rating", value: String(repeating: "★", count: max(0, min(5, rating))))
                    }
                    if book.isAudio, book.fileNames.count > 1 {
                        LabeledContent("Tracks", value: "\(book.fileNames.count)")
                    }
                    if !book.isAudio {
                        LabeledContent("Bookmarks", value: "\(book.bookmarks.count)")
                    }
                }
                Section {
                    Button("Edit Details", action: onEdit)
                    if BookMaster.shared.isLinked {
                        Button("Comments & Suggestions") { showNotes = true }
                    }
                    Button("Remove from Library", role: .destructive, action: onDelete)
                }
            }
            .navigationTitle("Book Info")
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(backdrop)
            .task { if let color = cover?.averageColor { tint = Color(color) } }
            .sheet(isPresented: $showNotes) { BookNotesView(book: book) }
        }
        .presentationDetents([.medium, .large])
    }
}

struct BookEditSheet: View {
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
