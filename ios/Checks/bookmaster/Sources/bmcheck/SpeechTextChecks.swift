import Foundation

func runSpeechTextChecks() {
    section("Read-aloud text flow")
    check("printed line breaks become spaces",
          SpeechText.spoken("There were far too\nmany stops in this line.") == "There were far too many stops in this line.")
    check("words hyphenated across printed lines are rejoined",
          SpeechText.spoken("The extraor-\ndinary answer") == "The extraordinary answer")
    check("real compound words keep their hyphen",
          SpeechText.spoken("A well-known answer") == "A well-known answer")
    check("soft hyphens and ebook ligatures do not reach the voice",
          SpeechText.spoken("dif\u{00AD}ﬁcult ﬂowers") == "difficult flowers")
    check("unambiguous abbreviations are spoken naturally",
          SpeechText.spoken("Use it, e.g. here, vs. there, etc.") == "Use it, for example here, versus there, et cetera")
    check("a wrapped clause remains one utterance",
          SpeechText.shouldJoin(previous: "There was still", separator: "\n", next: "more to say."))
    check("a real sentence ending stays separate",
          !SpeechText.shouldJoin(previous: "It ended.", separator: "\n", next: "Another began."))
    check("a title at a line end does not strand the name",
          SpeechText.shouldJoin(previous: "She asked Dr.", separator: "\n", next: "Morgan to stay."))
    check("layout spaces alone do not merge sentences",
          !SpeechText.shouldJoin(previous: "It ended.", separator: "   ", next: "Another began."))
}
