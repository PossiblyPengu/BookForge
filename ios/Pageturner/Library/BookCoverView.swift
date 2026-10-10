import SwiftUI

/// A book's cover — the real art when there is some, otherwise a designed
/// jacket in a colour chosen from the title so the shelf isn't a wall of one
/// gradient. Small badges mark audiobooks and how far you are.
struct BookCoverView: View {
    let book: Book
    let cover: UIImage?
    var showsBadges = true
    var corner: CGFloat = 10

    var body: some View {
        ZStack(alignment: .bottom) {
            if let cover {
                Image(uiImage: cover).resizable().scaledToFill()
            } else {
                jacket
            }
            if showsBadges { badges }
        }
        .aspectRatio(2 / 3, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .shadow(color: .black.opacity(0.22), radius: 8, y: 4)
        .accessibilityHidden(true)
    }

    private var jacket: some View {
        let base = Self.colour(for: book.title)
        return ZStack {
            LinearGradient(colors: [base, base.opacity(0.72)], startPoint: .topLeading, endPoint: .bottomTrailing)
            VStack(spacing: 6) {
                Text(book.title)
                    .font(.system(.footnote, design: .serif).weight(.semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(5)
                if !book.author.isEmpty {
                    Text(book.author)
                        .font(.system(.caption2, design: .serif))
                        .opacity(0.85)
                        .lineLimit(2)
                }
            }
            .foregroundStyle(.white)
            .padding(12)
        }
    }

    private var badges: some View {
        HStack(alignment: .bottom) {
            if book.isAudio {
                Image(systemName: "headphones")
                    .font(.caption2.weight(.bold))
                    .padding(6)
                    .background(.ultraThinMaterial, in: Circle())
            }
            Spacer(minLength: 0)
            if let p = book.progression, p > 0 {
                Text("\(Int((p * 100).rounded()))%")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.ultraThinMaterial, in: Capsule())
            }
        }
        .padding(6)
    }

    /// A warm, book-cloth colour from the title — the same title always gets the same one.
    static func colour(for title: String) -> Color {
        var hash: UInt64 = 5381
        for byte in title.utf8 { hash = hash &* 33 &+ UInt64(byte) }
        let hue = Double(hash % 360) / 360
        return Color(hue: hue, saturation: 0.45, brightness: 0.55)
    }
}

/// The cover grid shared by the library and search.
struct BookGrid: View {
    let books: [Book]
    @EnvironmentObject private var library: LibraryStore
    @Environment(AppRouter.self) private var router

    private let columns = [GridItem(.adaptive(minimum: 108, maximum: 168), spacing: 18)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 24) {
            ForEach(books) { book in
                Button { router.open(book, library: library) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        BookCoverView(book: book, cover: library.cover(for: book))
                        Text(book.title)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(2)
                            .foregroundStyle(.primary)
                        if !book.author.isEmpty {
                            Text(book.author)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel(for: book))
                .contextMenu {
                    Button { router.detail = book } label: {
                        Label("Book Info", systemImage: "info.circle")
                    }
                    Button { router.editing = book } label: {
                        Label("Edit Details", systemImage: "pencil")
                    }
                    Divider()
                    Button(role: .destructive) { library.delete(book) } label: {
                        Label("Remove from Library", systemImage: "trash")
                    }
                }
            }
        }
    }

    private func accessibilityLabel(for book: Book) -> String {
        var parts = [book.title]
        if !book.author.isEmpty { parts.append("by \(book.author)") }
        if book.isAudio { parts.append("audiobook") }
        if let p = book.progression, p > 0 { parts.append("\(Int((p * 100).rounded())) percent") }
        return parts.joined(separator: ", ")
    }
}
