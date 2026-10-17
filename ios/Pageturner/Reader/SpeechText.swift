import Foundation

enum SpeechText {
    static func spoken(_ source: String) -> String {
        var text = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{00AD}", with: "")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "ﬀ", with: "ff")
            .replacingOccurrences(of: "ﬁ", with: "fi")
            .replacingOccurrences(of: "ﬂ", with: "fl")
            .replacingOccurrences(of: "ﬃ", with: "ffi")
            .replacingOccurrences(of: "ﬄ", with: "ffl")

        text = replacing(#"(?<=\p{Ll})[-‐‑]\s*\n\s*(?=\p{Ll})"#, in: text, with: "")
        text = replacing(#"[\t\n\v\f ]+"#, in: text, with: " ")
        text = replacing(#"\b[eE]\.\s*[gG]\.(?=\s|$)"#, in: text, with: "for example")
        text = replacing(#"\b[iI]\.\s*[eE]\.(?=\s|$)"#, in: text, with: "that is")
        text = replacing(#"\b[vV][sS]\.(?=\s|$)"#, in: text, with: "versus")
        text = replacing(#"\b[eE][tT][cC]\.(?=\s|$)"#, in: text, with: "et cetera")
        text = replacing(#"\s+([,;:.!?…])"#, in: text, with: "$1")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // a running page number ("42", "- 42 -", "Page 42") is not part of the story
        if AppPrefs.speechSkipsPageNumbers, isPageNumber(text) { return "" }
        return text
    }

    /// Only digits (at most four), or "page" and digits, or those between dashes or brackets.
    static func isPageNumber(_ text: String) -> Bool {
        text.range(of: #"^[\[(\-–—\s]*(?:page\s+)?\d{1,4}[\])\-–—\s]*$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func shouldJoin(previous: String, separator: String, next: String) -> Bool {
        guard separator.contains(where: \.isNewline) else { return false }
        let left = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = next.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty, !right.isEmpty else { return false }
        if left.range(of: #"[.!?…][\"'”’)]*$"#, options: .regularExpression) == nil { return true }
        return left.range(of: #"\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.[\"'”’)]*$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func replacing(_ pattern: String, in text: String, with replacement: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex ..< text.endIndex, in: text)
        return expression.stringByReplacingMatches(in: text, range: range, withTemplate: replacement)
    }
}
