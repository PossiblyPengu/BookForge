import Foundation

/// What is lit while a book is read aloud. Each is its own choice — any mix of the three, or none.
struct ReadAloudHighlights: Codable, Equatable {
    /// The sentence being spoken.
    var sentence: Bool
    /// The line of the page the voice is on, as a band across it.
    var line: Bool
    /// The word being spoken.
    var word: Bool

    init(sentence: Bool = true, line: Bool = false, word: Bool = true) {
        self.sentence = sentence
        self.line = line
        self.word = word
    }

    /// Line and word both need to know where in the sentence the voice is.
    var needsWords: Bool { line || word }
    var isOff: Bool { !sentence && !line && !word }

    /// Settings saved before one of these existed lack its key: that one takes its default.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let standard = ReadAloudHighlights()
        sentence = try container.decodeIfPresent(Bool.self, forKey: .sentence) ?? standard.sentence
        line = try container.decodeIfPresent(Bool.self, forKey: .line) ?? standard.line
        word = try container.decodeIfPresent(Bool.self, forKey: .word) ?? standard.word
    }
}
