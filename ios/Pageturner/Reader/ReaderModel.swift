import Foundation
import ReadiumNavigator
import ReadiumShared
import SwiftUI

/// A footnote or endnote the reader tapped — shown in a sheet instead of jumping to it.
struct Footnote: Identifiable {
    let id = UUID()
    let text: String
    /// What it was called where it was cited: "3", "†".
    let label: String?
    let link: ReadiumShared.Link
}

@MainActor
final class ReaderModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var book: Book
    @Published var showChrome = true
    @Published var settings = ReaderSettings.load()
    @Published var toc: [ReadiumShared.Link] = []
    @Published var canReadAloud = false
    @Published var isSearchable = false
    @Published private(set) var readAloud: ReadAloud?
    @Published var notice: String?
    @Published private(set) var isCurrentLocationBookmarked = false
    /// The chapter the reader is in, for the title chip. Nil for comics and PDFs without an outline.
    @Published private(set) var chapterTitle: String?
    @Published private(set) var searchInFlight = false
    @Published private(set) var searchResults: [Locator] = []
    /// Where a "Back" button would return to after a jump.
    @Published private(set) var history = JumpHistory()
    @Published var footnote: Footnote?
    /// The highlight whose colour and note are being edited.
    @Published var editingHighlight: Highlight?

    private let library: LibraryStore
    private var publication: Publication?
    private var navigator: (any VisualNavigator)?
    private(set) var navigatorController: UIViewController?
    private var directionalAdapter: DirectionalNavigationAdapter?
    private var inputTokens: Set<InputObservableToken> = []
    /// Every page turn used to re-encode and rewrite the whole catalogue
    /// JSON — a disk write per page. Coalesced here and flushed on close.
    private var saveTask: Task<Void, Never>?
    private var currentLocator: Locator?
    /// Where and when this sitting began, for the BookMaster session push.
    private var sessionStart: (at: Date, progression: Double)?
    private var searchTask: Task<Void, Never>?
    /// Where the reader was when this app began a jump, and the location before
    /// the latest one — together they tell a jump's origin however the two
    /// callbacks (jumped / location changed) happen to be ordered.
    private var pendingOrigin: Locator?
    private var previousLocator: Locator?
    /// Set while "Back" is navigating, so returning isn't recorded as a jump.
    private var returning = false
    static let highlightGroup = "user-highlights"

    init(book: Book, library: LibraryStore) {
        self.book = book
        self.library = library
    }

    func open() async {
        do {
            let publication = try await Readium.shared.open(url: library.fileURL(for: book))
            self.publication = publication
            var initial = book.locatorJSON.flatMap { try? Locator(jsonString: $0) }
            // no saved place but a progression (a jump to where BookMaster has
            // the book, or a restored backup): find that point in the book
            if initial == nil, let progression = book.progression, progression > 0.001 {
                initial = await publication.locate(progression: min(progression, 0.999))
            }

            // comics (cbz) are opened by the EPUB navigator too — the CBZ one is deprecated
            if publication.conforms(to: .epub) || publication.conforms(to: .divina) {
                var config = EPUBNavigatorViewController.Configuration(
                    preferences: settings.epubPreferences
                )
                // custom action on the selection menu — handled by
                // ReaderContainerViewController in the responder chain
                var actions = EditingAction.defaultActions + [
                    EditingAction(
                        title: "Highlight",
                        action: #selector(ReaderContainerViewController.highlightSelection)
                    ),
                ]
                if BookMaster.shared.isLinked {
                    actions.append(EditingAction(
                        title: "Quote",
                        action: #selector(ReaderContainerViewController.quoteSelection)
                    ))
                }
                config.editingActions = actions
                let nav = try EPUBNavigatorViewController(
                    publication: publication,
                    initialLocation: initial,
                    config: config
                )
                nav.delegate = self
                install(navigator: nav, controller: nav)
            } else if publication.conforms(to: .pdf) {
                let nav = try PDFNavigatorViewController(
                    publication: publication,
                    initialLocation: initial,
                    config: .init(),
                    delegate: self
                )
                install(navigator: nav, controller: nav)
            } else {
                phase = .failed("This book's format isn't supported yet.")
                return
            }

            book.lastOpenedAt = Date()
            library.update(book)
            canReadAloud = ReadAloud.canSpeak(publication)
            isSearchable = publication.isSearchable
            toc = (try? await publication.tableOfContents().get()) ?? []
            // a comic's reading order is every page — not a contents worth listing
            if toc.isEmpty, !publication.conforms(to: .divina) { toc = publication.readingOrder }
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Edge taps turn pages (DirectionalNavigationAdapter); anything left over
    /// toggles the chrome — same setup as the Readium Test App.
    private func install(navigator: any VisualNavigator, controller: UIViewController) {
        self.navigator = navigator

        // container puts our selection-action selectors in the responder chain
        let container = ReaderContainerViewController(contentController: controller)
        container.onHighlightSelection = { [weak self] in self?.highlightSelection() }
        container.onQuoteSelection = { [weak self] in self?.quoteSelection() }
        navigatorController = container

        let adapter = DirectionalNavigationAdapter(animatedTransition: true)
        adapter.bind(to: navigator)
        directionalAdapter = adapter

        navigator.addObserver(.activate { [weak self] _ in
            self?.toggleChrome()
            return true
        }).store(in: &inputTokens)

        applyHighlights()
        (navigator as? DecorableNavigator)?.observeDecorationInteractions(inGroup: Self.highlightGroup) { [weak self] event in
            self?.highlightActivated(event.decoration.id)
        }
    }

    func toggleChrome() {
        withAnimation { showChrome.toggle() }
    }

    func go(to link: ReadiumShared.Link) {
        guard let navigator else { return }
        navigate { await navigator.go(to: link) }
    }

    func go(to locator: Locator) {
        guard let navigator else { return }
        navigate { await navigator.go(to: locator, options: NavigatorGoOptions(animated: true)) }
    }

    /// The scrubber: jump to a point `progression` (0…1) through the book.
    func go(toProgression progression: Double) {
        guard let publication, let navigator else { return }
        navigate {
            guard let target = await publication.locate(progression: min(max(progression, 0), 0.999)) else { return false }
            return await navigator.go(to: target, options: NavigatorGoOptions(animated: false))
        }
    }

    /// A jump the reader asked for: where they are now is the way back. (The
    /// navigator reports the jump itself from inside `go`, so the origin only
    /// needs to stand until it returns.)
    private func navigate(_ jump: @escaping () async -> Bool) {
        pendingOrigin = currentLocator
        Task {
            _ = await jump()
            pendingOrigin = nil
        }
    }

    // MARK: - Back

    /// A jump was made (the contents, a search hit, a link in the page, the
    /// scrubber): remember where the reader was, so Back can return.
    fileprivate func recordJump(to target: Locator) {
        guard !returning else { return }
        // Read aloud follows the narration with jumps of its own; only a jump the
        // reader asked for counts then
        let own = pendingOrigin
        let reading = readAloud?.isActive == true
        guard let origin = own ?? (reading ? nil : origin(ofJumpTo: target)),
              let from = spot(origin), let landed = spot(target)
        else { return }
        history.record(origin: from, landed: landed)
    }

    /// The origin of a jump the navigator made on its own (a link in the page):
    /// the current location — or, when it has already moved on to the target
    /// by the time this is told, the one before.
    private func origin(ofJumpTo target: Locator) -> Locator? {
        guard let current = currentLocator else { return nil }
        let moved = current.href == target.href
            && abs((current.locations.progression ?? 0) - (target.locations.progression ?? 0)) < 0.02
        return moved ? (previousLocator ?? current) : current
    }

    private func spot(_ locator: Locator) -> JumpHistory.Spot? {
        guard let json = try? locator.jsonString() else { return nil }
        return JumpHistory.Spot(
            locatorJSON: json, href: locator.href.string,
            progression: locator.locations.totalProgression ?? 0)
    }

    func goBack() {
        guard let spot = history.goBack(),
              let locator = try? Locator(jsonString: spot.locatorJSON),
              let navigator
        else { return }
        returning = true
        Task {
            _ = await navigator.go(to: locator, options: NavigatorGoOptions(animated: true))
            returning = false
        }
    }

    func dismissBack() { history.clear() }

    /// "Back to 45%" — what the chip says.
    var backLabel: String? {
        history.back.map { "\(Int((min(max($0.progression, 0), 1) * 100).rounded()))%" }
    }

    // MARK: - Bookmarks

    private func bookmark(matching locator: Locator) -> Bookmark? {
        book.bookmarks.first { bm in
            guard let bl = try? Locator(jsonString: bm.locatorJSON) else { return false }
            return bl == locator
        }
    }

    func toggleBookmark() {
        guard let locator = currentLocator,
              let json = try? locator.jsonString()
        else { return }
        if let existing = bookmark(matching: locator) {
            book.bookmarks.removeAll { $0.id == existing.id }
        } else {
            let title = locator.title
                ?? chapterTitle(for: locator)
                ?? "Bookmark \(book.bookmarks.count + 1)"
            book.bookmarks.append(Bookmark(
                title: title,
                locatorJSON: json,
                progression: locator.locations.totalProgression
            ))
        }
        isCurrentLocationBookmarked = bookmark(matching: locator) != nil
        flushSave()
    }

    func removeBookmark(_ bookmark: Bookmark) {
        book.bookmarks.removeAll { $0.id == bookmark.id }
        flushSave()
    }

    func goToBookmark(_ bookmark: Bookmark) {
        guard let locator = try? Locator(jsonString: bookmark.locatorJSON) else { return }
        go(to: locator)
    }

    /// The TOC is an outline — a bookmark's chapter is the deepest entry whose
    /// file matches the locator's href (fragments ignored, last match wins
    /// because the spine is ordered).
    func chapterTitle(for locator: Locator) -> String? {
        var flat: [ReadiumShared.Link] = []
        func flatten(_ links: [ReadiumShared.Link]) {
            for link in links {
                flat.append(link)
                flatten(link.children)
            }
        }
        flatten(toc)
        let base = locator.href.string.split(separator: "#").first.map(String.init) ?? locator.href.string
        var match: ReadiumShared.Link?
        for link in flat {
            let lbase = link.url().string.split(separator: "#").first.map(String.init) ?? link.url().string
            if lbase == base { match = link }
        }
        return match?.title
    }

    // MARK: - Search

    func search(_ query: String) {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        guard let publication, !q.isEmpty else {
            searchResults = []
            searchInFlight = false
            return
        }
        searchInFlight = true
        searchTask = Task { @MainActor in
            defer { searchInFlight = false }
            switch await publication.search(query: q) {
            case let .success(iterator):
                var found: [Locator] = []
                // LocatorCollections stream in pages; cap so a common word in a
                // huge book doesn't produce an unbounded list.
                while let page = try? await iterator.next().get() {
                    if Task.isCancelled { return }
                    found.append(contentsOf: page.locators)
                    if found.count >= 200 { break }
                }
                searchResults = found
            case .failure:
                searchResults = []
                notice = "This book can't be searched."
            }
        }
    }

    func applySettings() {
        settings.save()
        (navigator as? EPUBNavigatorViewController)?
            .submitPreferences(settings.epubPreferences)
        readAloud?.setRate(settings.speechRate)
        readAloud?.setVoice(settings.voiceIdentifier)
    }

    // MARK: - Highlights

    /// Send the selected passage to BookMaster as a quote on this book.
    private func quoteSelection() {
        guard let selectable = navigator as? SelectableNavigator,
              let selection = selectable.currentSelection,
              let text = selection.locator.text.highlight?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return }
        let ref = book.bookMasterRef
        let progression = selection.locator.locations.totalProgression
        selectable.clearSelection()
        Task {
            let ok = await BookMaster.shared.postQuote(ref: ref, content: text, percent: progression)
            notice = ok ? "Quote sent to BookMaster" : "Couldn’t send the quote"
        }
    }

    /// "Highlight" in the selection menu — stores the locator, notes where in the
    /// book it was, and repaints.
    private func highlightSelection() {
        guard let selectable = navigator as? SelectableNavigator,
              let selection = selectable.currentSelection,
              let json = try? selection.locator.jsonString()
        else { return }
        book.highlights.append(Highlight(
            locatorJSON: json,
            text: selection.locator.text.highlight ?? "",
            chapter: chapterTitle(for: selection.locator),
            progression: selection.locator.locations.totalProgression
        ))
        applyHighlights()
        selectable.clearSelection()
        flushSave()
    }

    func removeHighlight(_ highlight: Highlight) {
        book.highlights.removeAll { $0.id == highlight.id }
        if editingHighlight?.id == highlight.id { editingHighlight = nil }
        applyHighlights()
        flushSave()
    }

    func goToHighlight(_ highlight: Highlight) {
        guard let locator = try? Locator(jsonString: highlight.locatorJSON) else { return }
        go(to: locator)
    }

    /// A tap on a highlight in the page opens its editor.
    private func highlightActivated(_ decorationID: String) {
        let prefix = "user-highlight-"
        guard decorationID.hasPrefix(prefix),
              let id = UUID(uuidString: String(decorationID.dropFirst(prefix.count))),
              let highlight = book.highlights.first(where: { $0.id == id })
        else { return }
        editingHighlight = highlight
    }

    /// Save a highlight's colour and note from the editor.
    func updateHighlight(_ id: UUID, color: HighlightColor, note: String) {
        guard let i = book.highlights.firstIndex(where: { $0.id == id }) else { return }
        book.highlights[i].color = color == .standard ? nil : color.rawValue
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        book.highlights[i].note = trimmed.isEmpty ? nil : trimmed
        applyHighlights()
        flushSave()
    }

    /// Send a highlight to BookMaster as a quote.
    func quoteHighlight(_ highlight: Highlight) {
        let text = highlight.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let ref = book.bookMasterRef
        Task {
            let ok = await BookMaster.shared.postQuote(ref: ref, content: text, percent: highlight.progression)
            notice = ok ? "Quote sent to BookMaster" : "Couldn’t send the quote"
        }
    }

    /// The book's highlights and notes as Markdown.
    func highlightsMarkdown() -> String {
        HighlightExport.markdown(title: book.title, author: book.author, highlights: book.highlights)
    }

    /// The Markdown written to a temporary file, for the share sheet.
    func highlightsFile() -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(HighlightExport.fileName(for: book.title))
        do {
            try highlightsMarkdown().write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }

    /// Re-applies every saved highlight to the document (the decorations group
    /// is replaced wholesale — same pattern as the read-aloud highlight).
    private func applyHighlights() {
        guard let decorable = navigator as? DecorableNavigator else { return }
        let decorations: [Decoration] = book.highlights.compactMap { h in
            guard let locator = try? Locator(jsonString: h.locatorJSON) else { return nil }
            return Decoration(
                id: "user-highlight-\(h.id.uuidString)",
                locator: locator,
                style: .highlight(tint: HighlightColor(saved: h.color).uiColor)
            )
        }
        decorable.apply(decorations: decorations, in: Self.highlightGroup)
    }

    // MARK: - Read aloud

    func toggleReadAloud() {
        if let readAloud {
            readAloud.playPause()
        } else {
            startReadAloud()
        }
    }

    private func startReadAloud() {
        guard let publication, let navigator,
              let readAloud = ReadAloud(
                  publication: publication,
                  navigator: navigator,
                  settings: settings,
                  displayTitle: book.title,
                  displayAuthor: book.author
              )
        else { return }
        readAloud.onError = { [weak self] message in self?.notice = message }
        readAloud.onVoiceFallback = { [weak self] in
            guard let self else { return }
            settings.voiceIdentifier = nil
            settings.save()
            notice = "That voice can't play — switched to the automatic voice."
        }
        self.readAloud = readAloud
        readAloud.start()
    }

    func stopReadAloud() {
        readAloud?.stop()
        readAloud = nil
    }

    func cycleRate() {
        let steps: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
        settings.speechRate = steps.first { $0 > settings.speechRate + 0.001 } ?? steps[0]
    }

    func goToFootnote(_ note: Footnote) {
        footnote = nil
        go(to: note.link)
    }

    /// Persist the position soon-ish rather than instantly, and immediately
    /// when the reader is going away (called from ReaderView.onDisappear).
    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            library.update(book)
        }
    }

    func flushSave() {
        saveTask?.cancel()
        saveTask = nil
        library.update(book)
    }

    /// A new sitting begins now, from wherever the book is open.
    func beginSession() {
        if sessionStart == nil, let p = book.progression { sessionStart = (Date(), p) }
    }

    /// Tell BookMaster how far this sitting got — called when the reader is
    /// left or the app goes to the background, not on every save. A peek that
    /// moved under half a percent is not a session.
    func endSession() {
        guard let start = sessionStart else { return }
        sessionStart = nil
        let end = book.progression ?? start.progression
        guard (end - start.progression) * 100 >= 0.5 else { return }
        let ref = book.bookMasterRef
        let minutes = Date().timeIntervalSince(start.at) / 60
        Task {
            await BookMaster.shared.syncProgress(
                bookKey: ref.title, ref: ref, percent: end, isAudio: false, force: true,
                pinned: { [weak self] id in self?.pin(id) })
            await BookMaster.shared.syncSession(
                ref: ref, percentStart: start.progression, percentEnd: end,
                minutes: minutes, at: Date())
        }
    }

    private func pin(_ id: String) {
        guard book.bookmasterId != id else { return }
        book.bookmasterId = id
        library.updateBookMaster(book.id) { $0.bookmasterId = id }
    }
}

// MARK: - Navigator delegates

extension ReaderModel: EPUBNavigatorDelegate, PDFNavigatorDelegate {
    func navigator(_ navigator: Navigator, didJumpTo locator: Locator) {
        recordJump(to: locator)
    }

    /// A footnote or endnote reference: show the note in a sheet instead of
    /// jumping to the end of the chapter and losing the place.
    func navigator(_ navigator: Navigator, shouldNavigateToNoteAt link: ReadiumShared.Link, content: String, referrer: String?) -> Bool {
        let text = BookText.plain(fromHTML: content).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return true }   // nothing to show — follow the link as usual
        let label = referrer.map { BookText.plain(fromHTML: $0).trimmingCharacters(in: .whitespacesAndNewlines) }
        footnote = Footnote(text: text, label: (label?.isEmpty ?? true) ? nil : label, link: link)
        return false
    }

    func navigator(_ navigator: Navigator, locationDidChange locator: Locator) {
        previousLocator = currentLocator
        currentLocator = locator
        // reading on from where a jump landed lets the way back go
        if history.back != nil { history.readOn(to: locator.locations.totalProgression ?? book.progression ?? 0) }
        book.locatorJSON = try? locator.jsonString()
        book.progression = locator.locations.totalProgression
        isCurrentLocationBookmarked = bookmark(matching: locator) != nil
        chapterTitle = self.chapterTitle(for: locator)
        scheduleSave()
        beginSession()
        let ref = book.bookMasterRef
        let progression = book.progression ?? 0
        Task {
            await BookMaster.shared.syncProgress(
                bookKey: ref.title, ref: ref, percent: progression, isAudio: false,
                pinned: { [weak self] id in self?.pin(id) })
        }
    }

    func navigator(_ navigator: Navigator, presentError error: NavigatorError) {
        notice = "This action isn't allowed in this publication."
    }
}
