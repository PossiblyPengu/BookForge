import Foundation

// Checks for the quality-of-life logic: how long a book will take at this reader's pace, the rewind after a
// pause, and the order a library is shown in. No servers needed.

private func sitting(_ book: UUID, minutes: Double, from: Double, to: Double, audio: Bool = false) -> ReadingSession {
    ReadingSession(bookID: book, title: "T", end: Date(), minutes: minutes, progressStart: from, progressEnd: to, audio: audio)
}

@MainActor
func runQolChecks() {
    section("Time left, smart rewind, library order")
    let a = UUID(), b = UUID()
    // 30 minutes for 10% of the book = 300 minutes a book
    let own = [sitting(a, minutes: 30, from: 0, to: 0.1)]
    check("the pace is minutes over the part of the book covered", ReadingPace.minutesPerBook(own, bookID: a) == 300)
    check("with no history there is no estimate", ReadingPace.minutesPerBook([], bookID: a) == nil)
    check("audio sittings are not text reading", ReadingPace.minutesPerBook([sitting(a, minutes: 30, from: 0, to: 0.1, audio: true)]) == nil)
    check("another book's sittings do when this book has none", ReadingPace.minutesPerBook(own, bookID: b) == 300)
    check("a sitting that went nowhere (a book left open) is not a pace",
          ReadingPace.minutesPerBook([sitting(a, minutes: 300, from: 0.5, to: 0.5)]) == nil
          && ReadingPace.minutesPerBook([sitting(a, minutes: 360, from: 0.1, to: 0.12)]) == nil)
    check("time left is what remains at that pace", ReadingPace.minutesLeft(progress: 0.5, minutesPerBook: 300) == 150
          && ReadingPace.minutesLeft(progress: 0.999, minutesPerBook: 300) == nil && ReadingPace.minutesLeft(progress: .nan, minutesPerBook: 300) == nil)
    check("it reads as people say it", ReadingPace.label(minutesLeft: 72) == "~1 h 12 min left" && ReadingPace.label(minutesLeft: 120) == "~2 h left"
          && ReadingPace.label(minutesLeft: 8.4) == "~8 min left" && ReadingPace.label(minutesLeft: 0.2) == "under a minute left")

    check("no rewind after a short pause, a little after longer ones, more after a long one",
          AudioChapters.smartRewind(pausedFor: 4) == 0 && AudioChapters.smartRewind(pausedFor: 30) == 2
          && AudioChapters.smartRewind(pausedFor: 300) == 5 && AudioChapters.smartRewind(pausedFor: 1800) == 10
          && AudioChapters.smartRewind(pausedFor: 86_400) == 20 && AudioChapters.smartRewind(pausedFor: .nan) == 0)

    func book(_ title: String, _ author: String) -> Book {
        Book(id: UUID(), title: title, author: author, fileName: "x.epub", fileNames: ["x.epub"], addedAt: Date())
    }
    check("articles do not decide where a title files",
          book("The Hobbit", "").sortTitle == "Hobbit" && book("A Tale of Two Cities", "").sortTitle == "Tale of Two Cities"
          && book("An Idiot Abroad", "").sortTitle == "Idiot Abroad" && book("The", "").sortTitle == "The"
          && book("Theory of Everything", "").sortTitle == "Theory of Everything" && book("Anathem", "").sortTitle == "Anathem")
    check("authors file by last name",
          book("T", "Frank Herbert").sortAuthor == "Herbert, Frank" && book("T", "Herbert, Frank").sortAuthor == "Herbert, Frank"
          && book("T", "Ursula K. Le Guin").sortAuthor == "Le Guin, Ursula K." && book("T", "Vincent van Gogh").sortAuthor == "van Gogh, Vincent"
          && book("T", "Plato").sortAuthor == "Plato"
          && book("T", "Neil Gaiman & Terry Pratchett").sortAuthor == "Gaiman, Neil" && book("T", "").sortAuthor == ""
          && book("T", "Martin Luther King Jr.").sortAuthor == "King, Martin Luther"
          && book("T", "Frank Herbert, Brian Herbert").sortAuthor == "Herbert, Frank")
}
