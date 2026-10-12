import Foundation

/// Where the words of a sentence fall in time, for a voice that says nothing about it: a neural voice
/// hands over one block of audio, where iOS's own voices call back for every word.
///
/// The estimate is the length of each word plus a pause where the punctuation asks for one, spread over
/// the part of the audio that is speech. Fitted against Piper voices reading 190 book sentences — with an
/// ASR's word timestamps as the reference — it is within a tenth of a second of the word for half the
/// words and within two tenths for 85%. Pure logic, so it is checked off-device (ios/Checks/bookmaster).
enum SpokenWords {
    /// A word to light: where it is in the sentence, and when it starts.
    struct Word: Equatable {
        /// The word without the punctuation around it.
        var range: Range<String.Index>
        /// Seconds into the audio at the voice's own pace — what the player reports.
        var start: TimeInterval
    }

    enum Pause: Int, Comparable {
        case none, clause, sentence

        static func < (a: Pause, b: Pause) -> Bool { a.rawValue < b.rawValue }
    }

    struct Token: Equatable {
        var range: Range<String.Index>
        /// How long the word takes, in units of one letter.
        var weight: Double
        /// What follows it.
        var pause: Pause
    }

    // MARK: Fitted numbers (units of one letter, which is about 45 ms)

    /// Every word takes this much besides its letters.
    static let wordBase = 1.2
    static let clausePause = 1.9
    static let sentencePause = 4.75
    /// A digit is spoken as several letters' worth ("1,200" is "one thousand two hundred").
    static let digitWeight = 3.0
    /// The highlight comes a little before the voice: that feels in step, a late one feels dragged.
    static let lead: TimeInterval = 0.05

    // MARK: Words

    /// The words of `text` — pieces between spaces, without the quotes and punctuation round them — and
    /// what each is followed by. Text with no spaces in it (Chinese, Japanese, Thai) is split by
    /// `split`, which the app backs with the system's word tokenizer.
    static func tokens(in text: String, split: ((String) -> [Range<String.Index>])? = nil) -> [Token] {
        let pieces: [Range<String.Index>]
        if let split, !text.contains(where: \.isWhitespace) {
            pieces = split(text)
        } else {
            pieces = spaced(text)
        }
        var found: [Token] = []
        for piece in pieces {
            let raw = text[piece]
            guard let first = raw.firstIndex(where: isWordCharacter),
                  let last = raw.lastIndex(where: isWordCharacter)
            else {
                // punctuation on its own ("—", "...") lengthens the pause after the word before it
                if let previous = found.indices.last {
                    found[previous].pause = max(found[previous].pause, pause(in: raw))
                }
                continue
            }
            let word = first ..< raw.index(after: last)
            var after = pause(in: raw[word.upperBound...])
            if after == .sentence, abbreviations.contains(raw[word].lowercased()) { after = .none }
            let weight = raw[word].reduce(0.0) { sum, character in
                character.isNumber ? sum + digitWeight : character.isLetter ? sum + 1 : sum
            }
            found.append(Token(range: word, weight: wordBase + weight, pause: after))
        }
        return found
    }

    /// Pieces of text between white space — and after a dash that joins two words ("ago—never", "ago--never"):
    /// the dash stays with the word before it, which is how the voice pauses there.
    private static func spaced(_ text: String) -> [Range<String.Index>] {
        var pieces: [Range<String.Index>] = []
        var start: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            if character.isWhitespace {
                if let from = start { pieces.append(from ..< index); start = nil }
            } else {
                let from = start ?? index
                start = from
                if index > from, let next = dashEnd(in: text, at: index) {
                    pieces.append(from ..< next)
                    start = nil
                    index = next
                    continue
                }
            }
            index = text.index(after: index)
        }
        if let from = start { pieces.append(from ..< text.endIndex) }
        return pieces
    }

    /// Em dashes (and the horizontal bar), which books set between words without spaces.
    private static let joiningDashes: Set<Character> = ["—", "―"]

    /// Where the dash at `index` ends, if it is one that follows a word and joins it to the next: an em
    /// dash, or two hyphens or more — plain-text books type a dash that way. One hyphen is part of the word.
    private static func dashEnd(in text: String, at index: String.Index) -> String.Index? {
        let character = text[index]
        let next = text.index(after: index)
        if joiningDashes.contains(character) { return next }
        // the first hyphen of a run that does not begin the piece
        guard character == "-", text[text.index(before: index)] != "-" else { return nil }
        var end = next
        while end < text.endIndex, text[end] == "-" { end = text.index(after: end) }
        return end > next ? end : nil
    }

    private static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber
    }

    /// Quotes and brackets that close a sentence without changing how it ends.
    private static let closers: Set<Character> = ["\"", "'", "”", "’", "»", "›", ")", "]", "}"]
    private static let sentenceMarks: Set<Character> = [".", "!", "?", "…", "。", "！", "？", "‼", "⁇", "⁈"]
    private static let clauseMarks: Set<Character> = [",", ";", ":", "—", "–", "-", "，", "；", "：", "、", "―"]
    /// A full stop after these is not the end of a sentence.
    private static let abbreviations: Set<String> = [
        "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "etc", "mt", "gen", "col", "capt", "lt", "sgt", "rev", "hon",
    ]

    private static func pause(in tail: Substring) -> Pause {
        guard let mark = tail.last(where: { !closers.contains($0) }) else { return .none }
        if sentenceMarks.contains(mark) { return .sentence }
        if clauseMarks.contains(mark) { return .clause }
        return .none
    }

    // MARK: Timing

    /// When each word starts, spread over `speech` (the part of the audio that is not silence).
    static func schedule(_ tokens: [Token], speech: ClosedRange<TimeInterval>) -> [Word] {
        guard !tokens.isEmpty else { return [] }
        var offsets: [Double] = []
        var total = 0.0
        for (i, token) in tokens.enumerated() {
            offsets.append(total)
            total += token.weight
            if i < tokens.count - 1 {
                switch token.pause {
                case .none: break
                case .clause: total += clausePause
                case .sentence: total += sentencePause
                }
            }
        }
        let span = speech.upperBound - speech.lowerBound
        return tokens.indices.map { i in
            Word(range: tokens[i].range, start: max(speech.lowerBound + span * offsets[i] / total - lead, 0))
        }
    }

    /// The word being said `time` seconds in: the last that has started — the first until any has.
    static func index(at time: TimeInterval, in words: [Word]) -> Int? {
        guard !words.isEmpty else { return nil }
        var low = 0, high = words.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if words[mid].start <= time { low = mid } else { high = mid - 1 }
        }
        return low
    }

    /// The stretch of `samples` that is speech: from the first to the last 10 ms that is louder than
    /// 2% of the loud parts. Voices start and end with a little silence.
    static func speech(in samples: [Float], sampleRate: Double) -> ClosedRange<TimeInterval> {
        guard sampleRate > 0, sampleRate.isFinite else { return 0 ... 0 }
        let duration = Double(samples.count) / sampleRate
        let window = max(Int(sampleRate * 0.01), 1)
        let count = samples.count / window
        guard count >= 3 else { return 0 ... duration }
        var level = [Float](repeating: 0, count: count)
        for w in 0 ..< count {
            var sum: Float = 0
            for i in (w * window) ..< ((w + 1) * window) { sum += samples[i] * samples[i] }
            level[w] = (sum / Float(window)).squareRoot()
        }
        let reference = level.sorted()[Int(Double(count - 1) * 0.95)]
        guard reference > 1e-4 else { return 0 ... duration }
        let threshold = reference * 0.02
        guard let first = level.firstIndex(where: { $0 > threshold }),
              let last = level.lastIndex(where: { $0 > threshold })
        else { return 0 ... duration }
        let seconds = Double(window) / sampleRate
        let from = Double(first) * seconds
        return from ... max(min(Double(last + 1) * seconds, duration), from)
    }
}
