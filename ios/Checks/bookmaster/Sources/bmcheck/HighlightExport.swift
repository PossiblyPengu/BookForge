import Foundation

/// The colours a passage can be highlighted in.
enum HighlightColor: String, CaseIterable, Identifiable {
    case yellow, green, blue, pink, purple

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    /// What a highlight made before colours existed (no colour saved) shows as.
    static let standard = HighlightColor.yellow

    init(saved: String?) {
        self = saved.flatMap(HighlightColor.init(rawValue:)) ?? .standard
    }
}

/// A book's highlights and notes as Markdown, to share or paste into another app.
enum HighlightExport {
    static func markdown(title: String, author: String, highlights: [Highlight]) -> String {
        var lines = ["# \(title)"]
        if !author.isEmpty { lines += ["", "*\(author)*"] }

        // in reading order; the ones with no place go last, oldest first
        let ordered = highlights.sorted {
            ($0.progression ?? .infinity, $0.createdAt) < ($1.progression ?? .infinity, $1.createdAt)
        }
        for highlight in ordered {
            let text = highlight.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let note = highlight.note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty || !note.isEmpty else { continue }
            lines += ["", "---", ""]
            if !text.isEmpty {
                // a quote block: every line prefixed, blank lines kept inside it
                lines += text.components(separatedBy: .newlines).map { $0.isEmpty ? ">" : "> \($0)" }
            }
            if !note.isEmpty {
                lines += text.isEmpty ? [] : [""]
                lines.append("**Note:** \(note)")
            }
            var place: [String] = []
            if let chapter = highlight.chapter?.trimmingCharacters(in: .whitespaces), !chapter.isEmpty {
                place.append(chapter)
            }
            if let progression = highlight.progression {
                place.append("\(Int((min(max(progression, 0), 1) * 100).rounded()))%")
            }
            if !place.isEmpty { lines += ["", "*\(place.joined(separator: " · "))*"] }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// A file name for the export: "Dune – Highlights.md", with anything a file
    /// system dislikes taken out.
    static func fileName(for title: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        var base = title.components(separatedBy: bad).joined(separator: " ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if base.isEmpty { base = "Book" }
        return "\(String(base.prefix(80))) – Highlights.md"
    }
}
