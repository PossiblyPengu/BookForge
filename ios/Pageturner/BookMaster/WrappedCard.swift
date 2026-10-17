import SwiftUI

/// The year in books as a card to share: the counts that matter, in BookMaster's colours.
struct WrappedCardView: View {
    let wrapped: BMWrapped

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(String(wrapped.year)) in books")
                .font(.system(size: 30, weight: .bold, design: .serif))
            HStack(alignment: .firstTextBaseline, spacing: 20) {
                stat("\(wrapped.booksRead)", wrapped.booksRead == 1 ? "book" : "books")
                stat("\(Int(wrapped.pagesRead))", "pages")
                stat("\(wrapped.sessionsCount)", wrapped.sessionsCount == 1 ? "sitting" : "sittings")
            }
            VStack(alignment: .leading, spacing: 8) {
                if let genre = wrapped.topGenre { line("Most read", genre) }
                if let title = wrapped.longestBook?.title { line("Longest book", title) }
                if let title = wrapped.fastestBook?.title { line("Quickest read", title) }
                if let day = wrapped.bestDay { line("Best day", day) }
            }
            Spacer(minLength: 0)
            Text("Pageturner · BookMaster")
                .font(.system(size: 10, weight: .medium))
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .padding(32)
        .frame(width: 360, height: 450, alignment: .topLeading)
        .background(
            LinearGradient(
                colors: [Color(red: 0.63, green: 0.33, blue: 0.16), Color(red: 0.35, green: 0.17, blue: 0.09)],
                startPoint: .topLeading, endPoint: .bottomTrailing))
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(size: 34, weight: .bold, design: .rounded)).minimumScaleFactor(0.6).lineLimit(1)
            Text(label).font(.system(size: 12)).opacity(0.8)
        }
    }

    private func line(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.system(size: 11, weight: .medium)).textCase(.uppercase).opacity(0.7)
            Text(value).font(.system(size: 16, weight: .semibold, design: .serif)).lineLimit(2)
        }
    }
}

enum WrappedCard {
    @MainActor
    static func image(_ wrapped: BMWrapped) -> UIImage? {
        let renderer = ImageRenderer(content: WrappedCardView(wrapped: wrapped))
        renderer.scale = 3
        return renderer.uiImage
    }
}
