import ReadiumNavigator
import ReadiumShared

func makeReadingTokenizer(_ defaultLanguage: Language?) -> ContentTokenizer {
    let tokenizer = makeTextContentTokenizer(
        defaultLanguage: defaultLanguage,
        contextSnippetLength: 50,
        textTokenizerFactory: { language in
            let sentences = makeDefaultTextTokenizer(unit: .sentence, language: language)
            return { text in
                let ranges = try sentences(text)
                var merged: [Range<String.Index>] = []
                for range in ranges {
                    if let previous = merged.last {
                        let separator = String(text[previous.upperBound ..< range.lowerBound])
                        if SpeechText.shouldJoin(
                            previous: String(text[previous]), separator: separator, next: String(text[range])
                        ) {
                            merged[merged.count - 1] = previous.lowerBound ..< range.upperBound
                            continue
                        }
                    }
                    merged.append(range)
                }
                return merged
            }
        }
    )

    return { element in
        try tokenizer(element).map { token in
            guard var text = token as? TextContentElement else { return token }
            text.segments = text.segments.map { segment in
                var segment = segment
                segment.text = SpeechText.spoken(segment.text)
                return segment
            }.filter { !$0.text.isEmpty }
            return text
        }
    }
}
