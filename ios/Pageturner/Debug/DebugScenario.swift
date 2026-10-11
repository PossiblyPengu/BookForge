#if DEBUG
import AVFoundation
import SwiftUI
import UIKit

/// Test hooks for the CI simulator run (.github/workflows/ios-sim.yml). Launch
/// arguments choose a screen and seed sample books, so every screen can be
/// photographed with nobody tapping:
///
///     -PTDebugSeed 1            fill an empty library with sample books, a listen and some history
///     -PTDebugScreen library    which screen to put up (see `run`)
///     -PTDebugReaderSheet …     with `reader`: contents | settings | search
///
/// Debug builds only — none of this is in the IPA.
@MainActor
enum DebugScenario {
    private static let defaults = UserDefaults.standard

    static var readerSheet: String? { defaults.string(forKey: "PTDebugReaderSheet") }

    static func run(library: LibraryStore, router: AppRouter, selectTab: @escaping (AppTab) -> Void) async {
        let seeding = defaults.bool(forKey: "PTDebugSeed")
        let screen = defaults.string(forKey: "PTDebugScreen")
        guard seeding || screen != nil else { return }
        if seeding, library.books.isEmpty { await seed(library) }
        guard let screen else { return }

        try? await Task.sleep(nanoseconds: 800_000_000)
        // Moby-Dick is the one with progress, shelves, highlights and a bookmark
        let text = library.books.first { $0.title == "Moby-Dick" } ?? library.books.first { !$0.isAudio }
        let audio = library.books.first { $0.isAudio }
        switch screen {
        case "library": selectTab(.library)
        case "stats": selectTab(.stats)
        case "together": selectTab(.together)
        case "search": selectTab(.search)
        case "settings": router.showSettings = true
        case "detail": router.detail = text
        case "edit": router.editing = text
        case "shelves": if let text { router.openShelves([text.id]) }
        case "reader": router.reading = text
        case "pdf": router.reading = library.books.first { $0.ext == "pdf" }
        case "cbz": router.reading = library.books.first { $0.ext == "cbz" }
        case "player": if let audio { PlaybackCoordinator.shared.start(audio, library: library) }
        case "link": router.showLink = true
        case "resume":
            // BookMaster has Alice at 62% and this phone has never opened her: opening asks
            if let alice = library.books.first(where: { $0.title.hasPrefix("Alice") }) {
                library.updateBookMaster(alice.id) { $0.bmRemotePercent = 62; $0.bmStatus = "reading" }
                router.open(library.books.first { $0.id == alice.id } ?? alice, library: library)
            }
        default: break
        }
    }

    // MARK: Sample data

    private struct Sample {
        var title: String
        var author: String
        var paragraphs: [String]
    }

    private static let samples = [
        Sample(title: "Moby-Dick", author: "Herman Melville", paragraphs: [
            "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation.",
            "Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing before coffin warehouses, and bringing up the rear of every funeral I meet—then, I account it high time to get to sea as soon as I can. This is my substitute for pistol and ball.",
            "There is nothing surprising in this. If they but knew it, almost all men in their degree, some time or other, cherish very nearly the same feelings towards the ocean with me.",
        ]),
        Sample(title: "Pride and Prejudice", author: "Jane Austen", paragraphs: [
            "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
            "However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.",
            "“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?” Mr. Bennet replied that he had not.",
        ]),
        Sample(title: "Alice’s Adventures in Wonderland", author: "Lewis Carroll", paragraphs: [
            "Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use of a book,” thought Alice “without pictures or conversations?”",
            "So she was considering in her own mind (as well as she could, for the hot day made her feel very sleepy and stupid), whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies, when suddenly a White Rabbit with pink eyes ran close by her.",
        ]),
    ]

    private static func markdown(_ sample: Sample) -> String {
        var out = "# \(sample.title)\n\n*\(sample.author)*\n\n"
        for chapter in 1...8 {
            out += "## Chapter \(chapter)\n\n"
            for i in 0..<6 {
                out += sample.paragraphs[(chapter + i) % sample.paragraphs.count] + "\n\n"
            }
        }
        return out
    }

    /// A WAV of silence — enough for the player to have something to open.
    private static func silence(seconds: Int, to url: URL) {
        let rate = 8_000
        let bytes = seconds * rate * 2
        var data = Data()
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); put32(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put32(16); put16(1); put16(1)
        put32(UInt32(rate)); put32(UInt32(rate * 2)); put16(2); put16(16)
        data.append(contentsOf: Array("data".utf8)); put32(UInt32(bytes))
        data.append(Data(count: bytes))
        try? data.write(to: url)
    }

    private static func writePDF(to url: URL) {
        let bounds = CGRect(x: 0, y: 0, width: 612, height: 792)
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: "The Quick Brown Fox",
            kCGPDFContextAuthor as String: "A. Typist",
        ]
        let data = UIGraphicsPDFRenderer(bounds: bounds, format: format).pdfData { context in
            for page in 1...3 {
                context.beginPage()
                ("Page \(page)" as NSString).draw(
                    at: CGPoint(x: 72, y: 72), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 28)])
                ("The quick brown fox jumps over the lazy dog. Pageturner reads PDFs too, and finds words like fox on page \(page)." as NSString)
                    .draw(in: CGRect(x: 72, y: 130, width: 468, height: 400), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
            }
        }
        try? data.write(to: url)
    }

    private static func writeCBZ(to url: URL) {
        var zip = ZipWriter()
        let colours: [UIColor] = [.systemTeal, .systemOrange, .systemPurple]
        for (i, colour) in colours.enumerated() {
            let png = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 1200)).pngData { context in
                colour.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 800, height: 1200))
                ("\(i + 1)" as NSString).draw(
                    at: CGPoint(x: 320, y: 450),
                    withAttributes: [.font: UIFont.boldSystemFont(ofSize: 300), .foregroundColor: UIColor.white])
            }
            zip.add(String(format: "page-%02d.png", i + 1), png)
        }
        try? zip.finish().write(to: url)
    }

    private static func seed(_ library: LibraryStore) async {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("pt-seed-\(UUID().uuidString)", isDirectory: true)
        let audioDir = dir.appendingPathComponent("The Silent Audiobook", isDirectory: true)
        try? fm.createDirectory(at: audioDir, withIntermediateDirectories: true)

        var urls: [URL] = []
        for sample in samples {
            let url = dir.appendingPathComponent("\(sample.title).md")
            try? markdown(sample).write(to: url, atomically: true, encoding: .utf8)
            urls.append(url)
        }
        for chapter in 1...3 {
            let url = audioDir.appendingPathComponent("Chapter \(chapter).wav")
            silence(seconds: 40, to: url)
            urls.append(url)
        }
        // a PDF with real text (to search) and a CBZ comic of three coloured pages
        let pdf = dir.appendingPathComponent("The Quick Brown Fox.pdf")
        writePDF(to: pdf)
        let cbz = dir.appendingPathComponent("Three Panels.cbz")
        writeCBZ(to: cbz)
        urls += [pdf, cbz]
        await library.importFiles(urls)

        // some state to look at: one book part-read, one nearly done, shelves, history
        let books = library.books
        if let first = books.first(where: { $0.title == "Moby-Dick" }) {
            var b = first
            b.progression = 0.42
            b.lastOpenedAt = Date()
            b.author = "Herman Melville"
            // highlights and a bookmark for the Contents sheet to list (their locators are
            // empty on purpose — they can be shown and edited, just not jumped to)
            let day = Date().addingTimeInterval(-86_400)
            b.highlights = [
                Highlight(locatorJSON: "{}", text: "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse…",
                          createdAt: day, chapter: "Chapter 1", progression: 0.02),
                Highlight(locatorJSON: "{}", text: "It is a way I have of driving off the spleen and regulating the circulation.",
                          createdAt: day.addingTimeInterval(60), color: "blue", note: "Love this line.", chapter: "Chapter 1", progression: 0.03),
                Highlight(locatorJSON: "{}", text: "This is my substitute for pistol and ball.",
                          createdAt: day.addingTimeInterval(120), color: "pink", chapter: "Chapter 2", progression: 0.2),
            ]
            b.bookmarks = [Bookmark(title: "Chapter 3", locatorJSON: "{}", progression: 0.25, createdAt: day)]
            library.update(b)
        }
        if let second = books.first(where: { $0.title == "Pride and Prejudice" }) {
            var b = second
            b.progression = 0.93
            b.lastOpenedAt = Date().addingTimeInterval(-86_400)
            library.update(b)
        }
        if let shelf = library.addShelf("Favourites") {
            library.setShelf(shelf, on: books.prefix(2).map(\.id), member: true)
        }
        _ = library.addShelf("To read")

        let log = ReadingLog.shared
        if log.sessions.isEmpty, let book = books.first {
            for (daysAgo, minutes) in [(0, 34.0), (1, 52.0), (2, 18.0), (3, 41.0), (5, 25.0), (6, 63.0), (8, 12.0), (9, 47.0)] {
                log.record(
                    book: book, minutes: minutes, from: 0.1, to: 0.2,
                    audio: daysAgo % 3 == 0, at: Date().addingTimeInterval(-Double(daysAgo) * 86_400))
            }
        }
    }
}
#endif
