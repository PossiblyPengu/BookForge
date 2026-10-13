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

    // a position that was sought to lands a hair before the chapter that was asked for
    check("index: a position a hair before a chapter's start is at its start (seek quantises to 1/600 s)", AudioChapters.index(at: 120 - 1.0 / 600, in: list) == 1)
    check("index: but not a second before it", AudioChapters.index(at: 119, in: list) == 0)

    // audio before the first marker is its own chapter
    let leadIn = AudioChapters.normalise([("One", 6, 100), ("", 100, nil), ("Three", 200, 300)], duration: 300)
    check("a lead-in before the first marker is a chapter of its own", leadIn.first?.title == "Opening" && leadIn.first?.start == 0 && leadIn.first?.end == 6, "\(leadIn.map(\.title)) \(leadIn.map(\.start))")
    check("…so every marker's chapter is still there", leadIn.map(\.title) == ["Opening", "One", "Chapter 2", "Three"], "\(leadIn.map(\.title))")
    check("…and the lead-in chapter runs up to the first marker, no gaps", zip(leadIn, leadIn.dropFirst()).allSatisfy { $0.end == $1.start })
    check("from the lead-in, next goes to chapter one and previous stays", AudioChapters.index(at: 2, in: leadIn) == 0 && AudioChapters.previousTarget(position: 2, in: leadIn) == 0)
    check("a first marker under a second in is not a lead-in", AudioChapters.normalise([("One", 0.4, 100)], duration: 100).map(\.title) == ["One"])
    check("a first marker at 0 is not either", AudioChapters.normalise([("One", 0, 100)], duration: 100).map(\.title) == ["One"])

    // which file holds a time
    let offsets: [TimeInterval] = [0, 120, 600]
    check("track: inside each file", AudioChapters.trackIndex(at: 50, offsets: offsets) == 0 && AudioChapters.trackIndex(at: 130, offsets: offsets) == 1 && AudioChapters.trackIndex(at: 700, offsets: offsets) == 2)
    check("track: on a boundary belongs to the file that starts there", AudioChapters.trackIndex(at: 120, offsets: offsets) == 1)
    check("track: the very end of the book is the last file", AudioChapters.trackIndex(at: 1_500, offsets: offsets) == 2)
    check("track: a hair before a file is that file (quantised seek)", AudioChapters.trackIndex(at: 120 - 1.0 / 600, offsets: offsets) == 1)
    check("track: none without files", AudioChapters.trackIndex(at: 5, offsets: []) == nil)

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
    check("not offered when abandoned on BookMaster", ResumeOffer.target(for: book(progression: 0.1, remote: 50, status: "abandoned")) == nil)
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

    section("Back history after a jump")
    func spot(_ href: String, _ p: Double) -> JumpHistory.Spot { .init(locatorJSON: "{\"href\":\"\(href)\"}", href: href, progression: p) }
    var h = JumpHistory()
    check("nothing to go back to at first", h.back == nil)
    check("a jump far away is remembered", h.record(origin: spot("ch1.xhtml", 0.10), landed: spot("notes.xhtml", 0.95)))
    check("…and Back returns to where you were", h.back == spot("ch1.xhtml", 0.10))
    check("a hop inside one file under 1% is not", !JumpHistory().recordedCopy(origin: spot("a", 0.500), landed: spot("a", 0.505)))
    check("a hop to another file is, however short", JumpHistory().recordedCopy(origin: spot("a", 0.500), landed: spot("b", 0.502)))
    check("going back pops it", h.goBack() == spot("ch1.xhtml", 0.10) && h.back == nil)
    check("going back with nothing there is nil", h.goBack() == nil)

    var g = JumpHistory()
    g.record(origin: spot("a", 0.10), landed: spot("b", 0.90))
    g.readOn(to: 0.90)   // the landing
    g.readOn(to: 0.93)
    check("reading a little past the landing keeps the way back", g.back != nil)
    g.readOn(to: 0.985)
    check("reading well past it (over 8%) drops the way back", g.back == nil)
    var g2 = JumpHistory()
    g2.record(origin: spot("a", 0.50), landed: spot("b", 0.10))
    g2.readOn(to: 0.10)
    g2.readOn(to: 0.01)
    check("reading backwards past it counts too", g2.back == nil)
    var g3 = JumpHistory()
    g3.record(origin: spot("a", 0.10), landed: spot("b", 0.90))
    g3.readOn(to: 0.90)
    g3.record(origin: spot("b", 0.90), landed: spot("c", 0.30))
    check("two jumps stack: Back goes to the newest origin first", g3.back == spot("b", 0.90))
    check("…then the one before", { _ = g3.goBack(); return g3.back == spot("a", 0.10) }())
    var g4 = JumpHistory()
    g4.record(origin: spot("a", 0.10), landed: spot("b", 0.90))
    check("jumping again from near the same origin does not stack a duplicate", !g4.record(origin: spot("a", 0.105), landed: spot("c", 0.60)) && g4.entries.count == 1)
    var g5 = JumpHistory()
    for i in 0..<40 { g5.record(origin: spot("f\(i)", Double(i) / 100), landed: spot("z", 0.99)) }
    check("the history is capped", g5.entries.count == JumpHistory.capacity, "\(g5.entries.count)")
    check("…keeping the newest", g5.back == spot("f39", 0.39))
    g5.clear()
    check("clear forgets everything", g5.back == nil)

    section("Highlight export")
    func hl(_ text: String, _ p: Double?, note: String? = nil, chapter: String? = nil, at: Double = 0) -> Highlight {
        Highlight(locatorJSON: "{}", text: text, createdAt: Date(timeIntervalSince1970: 1_700_000_000 + at),
                  color: nil, note: note, chapter: chapter, progression: p)
    }
    let md = HighlightExport.markdown(title: "Dune", author: "Frank Herbert", highlights: [
        hl("Second", 0.50, note: "remember this", chapter: "Book Two"),
        hl("First\nacross two lines", 0.10, chapter: "Book One"),
        hl("   ", nil),
        hl("No place, older", nil, at: 1),
        hl("No place, newer", nil, at: 2),
    ])
    check("title and author lead", md.hasPrefix("# Dune\n\n*Frank Herbert*\n"), String(md.prefix(40)))
    check("reading order, not creation order", (md.range(of: "First")?.lowerBound ?? md.endIndex) < (md.range(of: "Second")?.lowerBound ?? md.startIndex))
    check("ones with no place go last, oldest first", (md.range(of: "No place, older")?.lowerBound ?? md.startIndex) < (md.range(of: "No place, newer")?.lowerBound ?? md.startIndex)
          && (md.range(of: "Second")?.lowerBound ?? md.endIndex) < (md.range(of: "No place, older")?.lowerBound ?? md.startIndex))
    check("a blank highlight is skipped", !md.contains(">    "))
    check("a multi-line passage is one quote block", md.contains("> First\n> across two lines"))
    check("a note is included", md.contains("**Note:** remember this"))
    check("chapter and percent", md.contains("*Book One · 10%*") && md.contains("*Book Two · 50%*"), md)
    check("it ends with a newline", md.hasSuffix("\n"))
    check("no author, no author line", !HighlightExport.markdown(title: "T", author: "", highlights: []).contains("**"))
    check("a note on a highlight with no text still exports", HighlightExport.markdown(title: "T", author: "", highlights: [hl("", 0.2, note: "just a note")]).contains("**Note:** just a note"))
    check("file name", HighlightExport.fileName(for: "Dune") == "Dune – Highlights.md")
    check("file name drops what a file system dislikes", HighlightExport.fileName(for: "A/B: C?") == "A B C – Highlights.md", HighlightExport.fileName(for: "A/B: C?"))
    check("file name for an empty title", HighlightExport.fileName(for: "  ") == "Book – Highlights.md")
    check("colours: unknown falls back to yellow", HighlightColor(saved: "mauve") == .yellow && HighlightColor(saved: nil) == .yellow)
    check("colours: saved ones come back", HighlightColor(saved: "pink") == .pink && HighlightColor.allCases.count == 5)

    section("Dates on bookmarks and highlights")
    let nowDate = Date()
    var book = Book(id: UUID(), title: "T", author: "A", fileName: "x.epub", fileNames: ["x.epub"], addedAt: nowDate)
    let made = Date(timeIntervalSince1970: nowDate.timeIntervalSince1970 - 86_400 * 3)
    book.highlights = [Highlight(locatorJSON: "{}", text: "x", createdAt: made)]
    book.bookmarks = [Bookmark(title: "b", locatorJSON: "{}", progression: 0.2, createdAt: made)]
    // what the app does: write seconds since 1970, read with the default decoder — repeatedly
    func cycle(_ b: Book) -> Book {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        let data = try! enc.encode([b])
        return try! JSONDecoder().decode([Book].self, from: data)[0]
    }
    var cycled = book
    for _ in 0..<4 { cycled = cycle(cycled) }
    check("a highlight's date survives four save/load cycles", abs(cycled.highlights[0].createdAt.timeIntervalSince(made)) < 2, "\(cycled.highlights[0].createdAt)")
    check("so does a bookmark's", abs(cycled.bookmarks[0].createdAt.timeIntervalSince(made)) < 2, "\(cycled.bookmarks[0].createdAt)")
    check("new highlight fields survive", {
        var b = book
        b.highlights[0].color = "green"; b.highlights[0].note = "n"; b.highlights[0].chapter = "C"; b.highlights[0].progression = 0.4
        let r = cycle(b).highlights[0]
        return r.color == "green" && r.note == "n" && r.chapter == "C" && r.progression == 0.4
    }())
    // a drifted date (each mismatched save moved it a whole 31-year gap on) is walked back
    let drifted = made.timeIntervalSince1970 + 978_307_200 * 2
    check("a date drifted forward by two gaps is walked back", abs((StoredDate.read(drifted)?.timeIntervalSince(made)) ?? 9e9) < 2)
    check("a date from an early build (2001-based) is read right", abs((StoredDate.read(made.timeIntervalSinceReferenceDate)?.timeIntervalSince(made)) ?? 9e9) < 2)
    check("the web's milliseconds are read right", abs((StoredDate.read(made.timeIntervalSince1970 * 1000)?.timeIntervalSince(made)) ?? 9e9) < 2)
    check("zero and junk are no date", StoredDate.read(0) == nil && StoredDate.read(-5) == nil && StoredDate.read(.nan) == nil && StoredDate.read(nil) == nil)
    let old = #"[{"id":"\#(UUID().uuidString)","title":"T","author":"A","fileName":"x.epub","addedAt":\#(nowDate.timeIntervalSinceReferenceDate),"highlights":[{"id":"\#(UUID().uuidString)","locatorJSON":"{}","text":"old","createdAt":\#(made.timeIntervalSinceReferenceDate)}]}]"#
    let legacy = try? JSONDecoder().decode([Book].self, from: Data(old.utf8))
    check("a highlight from before colours decodes (no colour, no note)", legacy?.first?.highlights.first?.color == nil && legacy?.first?.highlights.first?.note == nil && legacy?.first?.highlights.first?.text == "old")
    check("…with its early-build date repaired", abs((legacy?.first?.highlights.first?.createdAt.timeIntervalSince(made)) ?? 9e9) < 2)
}


@MainActor
func runStatsChecks() {
    section("Local reading stats")
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    // Wed 14 Feb 2024, 15:00 UTC
    let now = Date(timeIntervalSince1970: 1_707_922_800)
    func at(daysAgo: Int, hour: Int = 12, minute: Int = 0) -> Date {
        let day = cal.date(byAdding: .day, value: -daysAgo, to: cal.startOfDay(for: now))!
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
    }
    let bookA = UUID(), bookB = UUID()
    func session(_ book: UUID, _ title: String, daysAgo: Int, minutes: Double, hour: Int = 12, audio: Bool = false) -> ReadingSession {
        ReadingSession(bookID: book, title: title, end: at(daysAgo: daysAgo, hour: hour), minutes: minutes, progressStart: 0, progressEnd: 0.1, audio: audio)
    }
    func stats(_ s: [ReadingSession], days: Int = 14) -> ReadingStats { ReadingStats.compute(s, now: now, calendar: cal, days: days) }

    let empty = stats([])
    check("no sessions: zeros", empty.minutesToday == 0 && empty.minutesTotal == 0 && empty.currentStreak == 0 && empty.longestStreak == 0 && empty.perBook.isEmpty)
    check("the chart always has the asked-for number of days, today last", empty.daily.count == 14 && empty.daily.last?.date == cal.startOfDay(for: now) && empty.daily.first?.date == at(daysAgo: 13, hour: 0))
    check("days are consecutive, oldest first", zip(empty.daily, empty.daily.dropFirst()).allSatisfy { cal.date(byAdding: .day, value: 1, to: $0.date) == $1.date })

    let one = stats([session(bookA, "Dune", daysAgo: 0, minutes: 30)])
    check("today's minutes", one.minutesToday == 30 && one.minutesLast7Days == 30 && one.minutesTotal == 30 && one.sessionCount == 1)
    check("a day of reading is a one-day streak", one.currentStreak == 1 && one.longestStreak == 1)
    check("today's bar is the last one", one.daily.last?.minutes == 30 && one.daily.dropLast().allSatisfy { $0.minutes == 0 })

    let alive = stats([session(bookA, "Dune", daysAgo: 1, minutes: 20), session(bookA, "Dune", daysAgo: 2, minutes: 20), session(bookA, "Dune", daysAgo: 3, minutes: 20)])
    check("a streak stays alive until today is over (nothing yet today)", alive.currentStreak == 3 && alive.minutesToday == 0, "\(alive.currentStreak)")
    let broken = stats([session(bookA, "Dune", daysAgo: 2, minutes: 20), session(bookA, "Dune", daysAgo: 3, minutes: 20)])
    check("…but not past a missed day", broken.currentStreak == 0 && broken.longestStreak == 2, "\(broken.currentStreak)/\(broken.longestStreak)")
    let gap = stats([session(bookA, "Dune", daysAgo: 0, minutes: 5), session(bookA, "Dune", daysAgo: 2, minutes: 5), session(bookA, "Dune", daysAgo: 3, minutes: 5), session(bookA, "Dune", daysAgo: 4, minutes: 5)])
    check("today alone is a streak of 1 after a gap", gap.currentStreak == 1)
    check("the longest streak is found in the past", gap.longestStreak == 3, "\(gap.longestStreak)")
    let thin = stats([session(bookA, "Dune", daysAgo: 0, minutes: 0.4), session(bookA, "Dune", daysAgo: 1, minutes: 0.4)])
    check("under a minute in a day does not make a streak", thin.currentStreak == 0)

    let week = stats([session(bookA, "Dune", daysAgo: 6, minutes: 10), session(bookA, "Dune", daysAgo: 7, minutes: 100)])
    check("'last 7 days' is today and the six before it", week.minutesLast7Days == 10, "\(week.minutesLast7Days)")
    check("…while the total keeps everything", week.minutesTotal == 110)
    check("old sessions fall off the chart but not the total", week.daily.map(\.minutes).reduce(0, +) == 110)
    check("a 3-day chart", stats([session(bookA, "Dune", daysAgo: 5, minutes: 7)], days: 3).daily.count == 3 && stats([], days: 0).daily.isEmpty)

    let edge = stats([
        ReadingSession(bookID: bookA, title: "Dune", end: at(daysAgo: 1, hour: 23, minute: 59), minutes: 10, progressStart: 0, progressEnd: 0.1, audio: false),
        ReadingSession(bookID: bookA, title: "Dune", end: at(daysAgo: 0, hour: 0, minute: 1), minutes: 10, progressStart: 0, progressEnd: 0.1, audio: false),
    ])
    check("11:59pm and 12:01am are different days", edge.minutesToday == 10 && edge.daily[12].minutes == 10 && edge.currentStreak == 2, "\(edge.minutesToday) \(edge.daily[12].minutes) \(edge.currentStreak)")

    let two = stats([
        session(bookA, "Dune", daysAgo: 0, minutes: 10), session(bookB, "Hyperion", daysAgo: 1, minutes: 60, audio: true),
        session(bookA, "Dune (renamed)", daysAgo: 2, minutes: 15),
    ])
    check("books ranked by time", two.perBook.map(\.bookID) == [bookB, bookA], "\(two.perBook.map(\.title))")
    check("minutes add up per book", two.perBook.first?.minutes == 60 && two.perBook.last?.minutes == 25)
    check("a book keeps its audio flag", two.perBook.first?.audio == true)
    let ties = stats([session(bookA, "Zebra", daysAgo: 0, minutes: 10), session(bookB, "Aardvark", daysAgo: 0, minutes: 10)])
    check("ties sort by title", ties.perBook.map(\.title) == ["Aardvark", "Zebra"])
    let junk = stats([session(bookA, "Dune", daysAgo: 0, minutes: 0), session(bookA, "Dune", daysAgo: 0, minutes: -5), session(bookA, "Dune", daysAgo: 0, minutes: .nan), session(bookA, "Dune", daysAgo: 0, minutes: 12)])
    check("zero, negative and NaN minutes are ignored", junk.minutesTotal == 12 && junk.sessionCount == 1)

    check("duration: minutes", ReadingStats.duration(minutes: 42.2) == "42m")
    check("duration: hours", ReadingStats.duration(minutes: 65) == "1h 05m" && ReadingStats.duration(minutes: 120) == "2h 00m")
    check("duration: nothing", ReadingStats.duration(minutes: 0) == "0m" && ReadingStats.duration(minutes: 0.2) == "0m")

    // a session survives the JSON round trip the log uses
    let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
    let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
    let original = session(bookA, "Dune", daysAgo: 3, minutes: 12.5, audio: true)
    let round = try? dec.decode([ReadingSession].self, from: enc.encode([original]))
    check("sessions round-trip through the log file", round == [original], "\(String(describing: round))")
}


@MainActor
func runLinkURLChecks() {
    section("BookMaster link addresses")
    let code = "0123456789abcdef0123456789abcdef"
    func u(_ s: String) -> URL { URL(string: s)! }

    check("the flow starts on BookMaster's link page", BMLinkURL.start.host == "bookmaster.pages.dev" && BMLinkURL.start.path == "/link/pageturner", BMLinkURL.start.absoluteString)
    let from = URLComponents(url: BMLinkURL.start, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "from" }?.value
    check("…telling it production Pageturner asked (an origin BookMaster accepts)", from == "https://pageturner.pages.dev", from ?? "nil")

    check("the return address yields the code", BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/?bm-link=\(code)")) == code)
    check("a preview build's address does too", BMLinkURL.code(fromReturn: u("https://feature-x.pageturner.pages.dev/?bm-link=\(code)")) == code)
    check("a path and fragment around it don't matter", BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/index.html?x=1&bm-link=\(code)#top")) == code)
    check("another host is refused", BMLinkURL.code(fromReturn: u("https://evil.example/?bm-link=\(code)")) == nil)
    check("a host that merely contains the name is refused", BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev.evil.example/?bm-link=\(code)")) == nil
          && BMLinkURL.code(fromReturn: u("https://notpageturner.pages.dev/?bm-link=\(code)")) == nil)
    check("plain http is refused", BMLinkURL.code(fromReturn: u("http://pageturner.pages.dev/?bm-link=\(code)")) == nil)
    check("no code, no link", BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/")) == nil
          && BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/?bm-link=")) == nil)
    check("a code that is too short or has odd characters is refused", BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/?bm-link=abc")) == nil
          && BMLinkURL.code(fromReturn: u("https://pageturner.pages.dev/?bm-link=abcdefgh%22%3Ex")) == nil)

    check("the app's own scheme yields the code", BMLinkURL.code(fromAppURL: u("pageturner://link?code=\(code)")) == code)
    check("…only on the link host", BMLinkURL.code(fromAppURL: u("pageturner://open?code=\(code)")) == nil)
    check("…and only for this scheme", BMLinkURL.code(fromAppURL: u("other://link?code=\(code)")) == nil)
    check("either shape through code(from:)", BMLinkURL.code(from: u("pageturner://link?code=\(code)")) == code
          && BMLinkURL.code(from: u("https://pageturner.pages.dev/?bm-link=\(code)")) == code
          && BMLinkURL.code(from: u("https://bookmaster.pages.dev/dashboard")) == nil)

    check("BookMaster's pages open in the sheet", BMLinkURL.isBookMasterPage(u("https://bookmaster.pages.dev/link/pageturner?from=x")))
    check("nothing else does", !BMLinkURL.isBookMasterPage(u("https://evil.example/")) && !BMLinkURL.isBookMasterPage(u("https://bookmaster.pages.dev.evil.example/"))
          && !BMLinkURL.isBookMasterPage(u("http://bookmaster.pages.dev/")) && !BMLinkURL.isBookMasterPage(u("https://sub.bookmaster.pages.dev/")))
}

private extension JumpHistory {
    /// `record` on a throwaway copy, to ask "would it be kept?" in one expression.
    func recordedCopy(origin: Spot, landed: Spot) -> Bool {
        var copy = self
        return copy.record(origin: origin, landed: landed)
    }
}
