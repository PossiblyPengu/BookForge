import SwiftUI

/// A quote as a picture to share: the passage in the reader's own page colours, with the book beneath.
struct QuoteCardView: View {
    let text: String
    let title: String
    let author: String
    let theme: ReaderSettings.ThemeChoice

    private var ink: Color { Color(rgb: theme.text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "quote.opening")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Color.ptAccent)
            Text(text)
                .font(.system(size: 25, design: .serif))
                .lineSpacing(5)
                .foregroundStyle(ink)
                .minimumScaleFactor(0.5)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .semibold, design: .serif))
                if !author.isEmpty { Text(author).font(.system(size: 13, design: .serif)) }
            }
            .foregroundStyle(ink.opacity(0.7))
            Text("Pageturner")
                .font(.system(size: 10, weight: .medium))
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(ink.opacity(0.4))
        }
        .padding(34)
        .frame(width: 360, height: 450, alignment: .topLeading)
        .background(Color(rgb: theme.background))
    }
}

/// Draws a quote card to an image at 1080 × 1350.
enum QuoteCard {
    @MainActor
    static func image(text: String, title: String, author: String, theme: ReaderSettings.ThemeChoice) -> UIImage? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let clipped = trimmed.count > 600 ? String(trimmed.prefix(600)) + "…" : trimmed
        let renderer = ImageRenderer(content: QuoteCardView(text: clipped, title: title, author: author, theme: theme))
        renderer.scale = 3
        return renderer.uiImage
    }
}

/// An image to hand to the share sheet.
struct SharedImage: Identifiable {
    let id = UUID()
    let image: UIImage
}
