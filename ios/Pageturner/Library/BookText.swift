import Foundation

/// ISBN handling for matching books across Pageturner and BookMaster.
enum ISBN {
    /// "978-0-441-17271-9", "urn:isbn:0441172717", "ISBN 0-441-17271-7" → the digits
    /// (and a trailing X) when the length and check digit are right, else nil.
    /// Anything with other letters in it (a `urn:uuid:` identifier) is not an ISBN.
    static func normalize(_ raw: String) -> String? {
        var s = raw.uppercased()
        for prefix in ["URN:", "ISBN-13", "ISBN-10", "ISBN:", "ISBN"] {
            s = s.replacingOccurrences(of: prefix, with: "")
        }
        s = s.replacingOccurrences(of: ":", with: "")
        var digits = ""
        for ch in s {
            if ch.isNumber { digits.append(ch) }
            else if ch == "X" { digits.append(ch) }
            else if ch == "-" || ch == " " { continue }
            else { return nil }
        }
        guard digits.count == 10 || digits.count == 13, isValid(digits) else { return nil }
        return digits
    }

    static func isValid(_ digits: String) -> Bool {
        let chars = Array(digits)
        if chars.count == 13 {
            guard !chars.contains("X") else { return false }
            let nums = chars.compactMap { $0.wholeNumberValue }
            guard nums.count == 13 else { return false }
            let sum = nums.enumerated().reduce(0) { $0 + $1.element * ($1.offset % 2 == 0 ? 1 : 3) }
            return sum % 10 == 0
        }
        if chars.count == 10 {
            var sum = 0
            for (i, ch) in chars.enumerated() {
                let v: Int
                if ch == "X" { guard i == 9 else { return false }; v = 10 }
                else if let n = ch.wholeNumberValue { v = n }
                else { return false }
                sum += v * (10 - i)
            }
            return sum % 11 == 0
        }
        return false
    }

    /// The same edition in a stable ISBN-13 form, for matching.
    static func canonical(_ raw: String) -> String? {
        guard let digits = normalize(raw) else { return nil }
        guard digits.count == 10 else { return digits }
        let body = "978" + digits.prefix(9)
        let sum = body.enumerated().reduce(0) { $0 + ($1.element.wholeNumberValue ?? 0) * ($1.offset % 2 == 0 ? 1 : 3) }
        return body + String((10 - sum % 10) % 10)
    }

    /// The best ISBN among several candidates: a valid 13 first, then a valid 10.
    static func best(of raws: [String]) -> String? {
        let valid = raws.compactMap { normalize($0) }
        return valid.first { $0.count == 13 } ?? valid.first
    }
}

/// Descriptions arrive as HTML in EPUB metadata and from catalogues.
enum BookText {
    /// Tags removed, paragraph and line breaks kept as newlines, entities decoded.
    static func plain(fromHTML html: String) -> String {
        var s = html
        // paragraphs and headings end with a blank line; a <br> or list item with a line break
        let paragraphs = try? NSRegularExpression(pattern: "(?i)<\\s*/(p|div|h[1-6])\\s*>", options: [])
        s = paragraphs?.stringByReplacingMatches(in: s, options: [], range: NSRange(s.startIndex..., in: s), withTemplate: "\n\n") ?? s
        let breaks = try? NSRegularExpression(pattern: "(?i)<\\s*(br\\s*/?|/li)\\s*>", options: [])
        s = breaks?.stringByReplacingMatches(in: s, options: [], range: NSRange(s.startIndex..., in: s), withTemplate: "\n") ?? s
        let tags = try? NSRegularExpression(pattern: "<[^>]+>", options: [])
        s = tags?.stringByReplacingMatches(in: s, options: [], range: NSRange(s.startIndex..., in: s), withTemplate: "") ?? s
        s = TextBook.decodeEntities(s)
        // collapse runs of spaces, keep paragraph breaks
        let lines = s.components(separatedBy: "\n").map {
            $0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        }
        var out: [String] = []
        for line in lines {
            if line.isEmpty { if out.last?.isEmpty == false { out.append("") } } else { out.append(line) }
        }
        while out.last?.isEmpty == true { out.removeLast() }
        return out.joined(separator: "\n")
    }

    /// "2021-03-04", "March 2021", "2021" → "2021".
    static func year(from raw: String) -> String? {
        guard let r = raw.range(of: "(1[0-9]{3}|20[0-9]{2})", options: .regularExpression) else { return nil }
        return String(raw[r])
    }
}
