import NaturalLanguage

extension SpokenWords {
    /// The words of `text` as read aloud: between spaces where there are spaces, and where there are
    /// none (Chinese, Japanese, Thai) wherever the system's word tokenizer says they are.
    static func words(in text: String) -> [Token] {
        tokens(in: text, split: systemSplit)
    }

    private static func systemSplit(_ text: String) -> [Range<String.Index>] {
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = text
        var words: [Range<String.Index>] = []
        tokenizer.enumerateTokens(in: text.startIndex ..< text.endIndex) { range, _ in
            words.append(range)
            return true
        }
        return words
    }
}
