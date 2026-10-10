import Foundation

// Checks for the app's pure logic: audiobook chapters, the BookMaster resume
// offer and the notification plan. No servers needed.

private func chapter(_ id: Int, _ title: String, _ start: Double, _ end: Double) -> AudioChapter {
    AudioChapter(id: id, title: title, start: start, end: end)
}

@MainActor
func runLogic() {
    section("Audiobook chapters")
    // a multi-file book: one chapter per file
    let tracks = AudioChapters.fromTracks(titles: ["Intro", "One", "Two"], offsets: [0, 120, 600], duration: 1_500)
    check("a chapter per file", tracks.count == 3, "\(tracks.count)")
    check("tracks start where the files do", tracks.map(\.start) == [0, 120, 600], "\(tracks.map(\.start))")
    check("each runs to the next, the last to the end", tracks.map(\.end) == [120, 600, 1_500], "\(tracks.map(\.end))")
    check("titles kept", tracks.map(\.title) == ["Intro", "One", "Two"])
    check("ids are the positions", tracks.map(\.id) == [0, 1, 2])

    // an m4b's markers arrive in any order, with gaps in the data
    let raw: [(title: String, start: TimeInterval, end: TimeInterval?)] = [
        ("Two", 600, 900), ("", 120, nil), ("Intro", 0, 120), ("Dup of one", 120.2, nil), ("Past the end", 5_000, nil),
        ("Negative", -4, nil),
    ]
    let marked = AudioChapters.normalise(raw, duration: 1_000)
    check("sorted by start", marked.map(\.start) == [0, 120, 600], "\(marked.map(\.start))")
    check("a marker on the same instant is dropped (first one wins)", marked.count == 3, "\(marked.count)")
    check("an untitled marker is 'Chapter N'", marked[1].title == "Chapter 2", marked[1].title)
    check("a marker past the end is dropped", !marked.contains { $0.start >= 1_000 })
    check("a marker before the start is dropped", !marked.contains { $0.start < 0 })
    check("the last chapter runs to its own end, clamped to the book", marked.last?.end == 900, "\(String(describing: marked.last?.end))")
    check("a chapter runs to the next one's start", marked[0].end == 120 && marked[1].end == 600, "\(marked.map(\.end))")
    check("a marker with no end runs to the book's end", AudioChapters.normalise([("Only", 0, nil)], duration: 300).first?.end == 300)
    check("an end past the book is clamped", AudioChapters.normalise([("A", 0, 9_999)], duration: 300).first?.end == 300)
    check("no markers, no chapters", AudioChapters.normalise([], duration: 300).isEmpty)
    check("nothing is made of an unknown duration", AudioChapters.normalise([("A", 0, nil)], duration: 0).isEmpty)
    check("lengths", tracks.map(\.length) == [120, 480, 900], "\(tracks.map(\.length))")

    let list = tracks
    check("index: the very start", AudioChapters.index(at: 0, in: list) == 0)
    check("index: inside the first", AudioChapters.index(at: 119.9, in: list) == 0)
    check("index: exactly on a boundary belongs to the chapter that starts there", AudioChapters.index(at: 120, in: list) == 1)
    check("index: inside the last", AudioChapters.index(at: 1_499, in: list) == 2)
    check("index: past the end is the last", AudioChapters.index(at: 99_999, in: list) == 2)
    check("index: before the first is the first", AudioChapters.index(at: -5, in: list) == 0)
    check("index: none without chapters", AudioChapters.index(at: 10, in: []) == nil)
    let many = (0..<400).map { chapter($0, "c\($0)", Double($0) * 60, Double($0 + 1) * 60) }
    check("index: binary search over 400 chapters", (0..<400).allSatisfy { AudioChapters.index(at: Double($0) * 60 + 30, in: many) == $0 })

    check("previous: well into a chapter restarts it", AudioChapters.previousTarget(position: 400, in: list) == 1)
    check("previous: at its head goes back one", AudioChapters.previousTarget(position: 121, in: list) == 0)
    check("previous: at the head of the first stays", AudioChapters.previousTarget(position: 1, in: list) == 0)
    check("previous: none without chapters", AudioChapters.previousTarget(position: 1, in: []) == nil)

    section("BookMaster resume offer")
    func book(progression: Double?, remote: Double?, status: String? = "reading", dismissed: Date? = nil) -> Book {
        var b = Book(id: UUID(), title: "Dune", author: "Frank Herbert", fileName: "x.epub", fileNames: ["x.epub"], addedAt: Date())
        b.progression = progression
        b.bmRemotePercent = remote
        b.bmStatus = status
        b.resumeDismissedAt = dismissed
        return b
    }
    check("offered when BookMaster is well ahead", ResumeOffer.target(for: book(progression: 0.18, remote: 62)) == 0.62)
    check("offered for a book never opened here", ResumeOffer.target(for: book(progression: nil, remote: 40)) == 0.4)
    check("not offered when this device is ahead", ResumeOffer.target(for: book(progression: 0.7, remote: 62)) == nil)
    check("not offered when level", ResumeOffer.target(for: book(progression: 0.62, remote: 62)) == nil)
    check("not offered for a trivial lead (under 2 points)", ResumeOffer.target(for: book(progression: 0.60, remote: 61)) == nil)
    check("offered at exactly the margin", ResumeOffer.target(for: book(progression: 0.60, remote: 62)) == 0.62)
    check("not offered with no remote position", ResumeOffer.target(for: book(progression: 0.1, remote: nil)) == nil)
    check("not offered for a zero remote position", ResumeOffer.target(for: book(progression: nil, remote: 0)) == nil)
    check("not offered once finished on BookMaster", ResumeOffer.target(for: book(progression: 0.1, remote: 100, status: "read")) == nil)
    check("not offered when given up on", ResumeOffer.target(for: book(progression: 0.1, remote: 50, status: "dnf")) == nil)
    check("not offered when BookMaster says it is all the way through", ResumeOffer.target(for: book(progression: 0.1, remote: 99.5)) == nil)
    check("want-to-read with a position still offers", ResumeOffer.target(for: book(progression: 0.1, remote: 30, status: "want_to_read")) == 0.3)
    check("a non-finite remote value is ignored", ResumeOffer.target(for: book(progression: 0.1, remote: .infinity)) == nil)

    let now = Date()
    check("a declined offer is quiet for a day",
          ResumeOffer.target(for: book(progression: 0.1, remote: 60, dismissed: now.addingTimeInterval(-3_600)), now: now) == nil)
    check("then it asks again",
          ResumeOffer.target(for: book(progression: 0.1, remote: 60, dismissed: now.addingTimeInterval(-90_000)), now: now) == 0.6)

    var jumped = book(progression: 0.18, remote: 62, dismissed: now)
    jumped.locatorJSON = "{\"href\":\"ch3.xhtml\"}"
    jumped.audioPosition = 1_234
    ResumeOffer.accept(&jumped, fraction: 0.62)
    check("accepting moves the book to BookMaster's place", jumped.progression == 0.62)
    check("accepting drops the saved locator and audio second", jumped.locatorJSON == nil && jumped.audioPosition == nil)
    check("accepting clears the decline", jumped.resumeDismissedAt == nil)
    var clamped = book(progression: 0.1, remote: 60)
    ResumeOffer.accept(&clamped, fraction: 7)
    check("an out-of-range jump is clamped", clamped.progression == 1)
    var turned = book(progression: 0.18, remote: 62)
    turned.locatorJSON = "{\"href\":\"ch3.xhtml\"}"
    ResumeOffer.decline(&turned, now: now)
    check("declining keeps the place and notes the time", turned.progression == 0.18 && turned.locatorJSON != nil && turned.resumeDismissedAt == now)
    check("labels round", ResumeOffer.label(0.625) == "63%" || ResumeOffer.label(0.625) == "62%")
    check("label of a whole number", ResumeOffer.label(0.62) == "62%")

    section("Notification plan")
    func nudge(_ id: String, from: String = "Kristen", title: String = "Hyperion", author: String? = "Dan Simmons", note: String? = nil) -> BMNudge {
        BMNudge(id: id, note: note, fromName: from, title: title, author: author)
    }
    let first = NotificationPlan.plan(nudges: [nudge("a")], notices: [], seen: nil)
    check("the first look announces nothing", first.items.isEmpty)
    check("…but remembers what is waiting", first.seen == ["nudge:a"], "\(first.seen)")

    let quiet = NotificationPlan.plan(nudges: [nudge("a")], notices: [], seen: first.seen)
    check("nothing new, nothing said", quiet.items.isEmpty)

    let fresh = NotificationPlan.plan(nudges: [nudge("a"), nudge("b", note: "you will love this")], notices: [], seen: first.seen)
    check("a new suggestion is announced once", fresh.items.count == 1 && fresh.items[0].id == "nudge:b", "\(fresh.items)")
    check("who it is from", fresh.items.first?.title == "Kristen suggested a book", fresh.items.first?.title ?? "nil")
    check("what it says", fresh.items.first?.body == "Hyperion by Dan Simmons — “you will love this”", fresh.items.first?.body ?? "nil")
    check("then both are remembered", fresh.seen == ["nudge:a", "nudge:b"])

    let bare = NotificationPlan.plan(nudges: [nudge("c", from: "", title: "Solaris", author: nil)], notices: [], seen: [])
    check("no sender, no author, no note", bare.items.first?.title == "A book suggestion" && bare.items.first?.body == "Solaris", "\(bare.items)")

    let answered = NotificationPlan.plan(nudges: [], notices: [], seen: ["nudge:a", "nudge:b"])
    check("an answered suggestion drops out of the remembered set", answered.seen.isEmpty, "\(answered.seen)")

    let notices = [
        BMNotice(id: "n1", app: "quest-log", text: "Your streak is at risk"),
        BMNotice(id: "n2", app: "kindred", text: "A new entry"),
    ]
    let noticed = NotificationPlan.plan(nudges: [], notices: notices, seen: ["notice:n1"])
    check("a new notice from another app is announced", noticed.items.count == 1 && noticed.items[0].title == "Kindred" && noticed.items[0].body == "A new entry", "\(noticed.items)")
    check("app names", NotificationPlan.appName("quest-log") == "Quest Log" && NotificationPlan.appName("bookmaster") == "BookMaster"
          && NotificationPlan.appName("") == "BookMaster" && NotificationPlan.appName("some-new_app") == "Some New App")

    let pile = NotificationPlan.plan(nudges: (1...5).map { nudge("p\($0)") }, notices: [], seen: [])
    check("a pile of new things becomes one notification", pile.items.count == 1 && pile.items[0].title == "5 new things on BookMaster", "\(pile.items)")
    check("…and all of them are remembered", pile.seen.count == 5)
    let three = NotificationPlan.plan(nudges: (1...3).map { nudge("q\($0)") }, notices: [], seen: [])
    check("three is still three", three.items.count == 3)
}
