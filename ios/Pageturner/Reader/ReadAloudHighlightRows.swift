import SwiftUI

/// What to light while the book is read aloud — the rows of a Settings section and of the reader's
/// Reading sheet. Any mix of the three; all off reads without marking the page.
struct ReadAloudHighlightRows: View {
    @Binding var highlights: ReadAloudHighlights

    var body: some View {
        row("Sentence", detail: "Marks the sentence being read", isOn: $highlights.sentence)
        row("Line", detail: "A soft band across the line the voice is on", isOn: $highlights.line)
        row("Word", detail: "Marks each word as it is said", isOn: $highlights.word)
    }

    private func row(_ title: String, detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .tint(.ptAccent)
    }
}

extension ReadAloudHighlightRows {
    /// The footer under the rows.
    static let footnote = "Word and line follow the voice as it reads. Neural voices don’t report where they are in a sentence, so for them the position is worked out from the sound, and can be a little off."
}
