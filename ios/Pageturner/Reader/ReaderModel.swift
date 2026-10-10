import Foundation
import ReadiumNavigator
import ReadiumShared
import SwiftUI

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
    @Published private(set) var searchInFlight = false
    @Published private(set) var searchResults: [Locator] = []

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

    init(book: Book, library: LibraryStore) {
        self.book = book
        self.library = library
    }

    func open() async {
        do {
            let publication = try await Readium.shared.open(url: library.fileURL(for: book))
            self.publication = publication
            let initial = book.locatorJSON.flatMap { try? Locator(jsonString: $0) }

            if publication.conforms(to: .epub) {
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
            if toc.isEmpty { toc = publication.readingOrder }
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
    }

    func toggleChrome() {
        withAnimation { showChrome.toggle() }
    }

    func go(to link: ReadiumShared.Link) {
        guard let navigator else { return }
        Task { _ = await navigator.go(to: link) }
    }

    func go(to locator: Locator) {
        guard let navigator else { return }
        Task { _ = await navigator.go(to: locator, options: NavigatorGoOptions(animated: true)) }
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
    private func chapterTitle(for locator: Locator) -> String? {
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

    /// "Highlight" in the selection menu — stores the locator and repaints.
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

    private func highlightSelection() {
        guard let selectable = navigator as? SelectableNavigator,
              let selection = selectable.currentSelection,
              let json = try? selection.locator.jsonString()
        else { return }
        book.highlights.append(Highlight(
            locatorJSON: json,
            text: selection.locator.text.highlight ?? ""
        ))
        applyHighlights()
        selectable.clearSelection()
        flushSave()
    }

    func removeHighlight(_ highlight: Highlight) {
        book.highlights.removeAll { $0.id == highlight.id }
        applyHighlights()
        flushSave()
    }

    func goToHighlight(_ highlight: Highlight) {
        guard let locator = try? Locator(jsonString: highlight.locatorJSON) else { return }
        go(to: locator)
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
                style: .highlight(tint: .systemYellow)
            )
        }
        decorable.apply(decorations: decorations, in: "user-highlights")
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
        endBookMasterSession()
    }

    /// Tell BookMaster how far this sitting got. A peek that moved under half
    /// a percent is not a session.
    private func endBookMasterSession() {
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
        library.update(book)
    }
}

// MARK: - Navigator delegates

extension ReaderModel: EPUBNavigatorDelegate, PDFNavigatorDelegate {
    func navigator(_ navigator: Navigator, locationDidChange locator: Locator) {
        currentLocator = locator
        book.locatorJSON = try? locator.jsonString()
        book.progression = locator.locations.totalProgression
        isCurrentLocationBookmarked = bookmark(matching: locator) != nil
        scheduleSave()
        if sessionStart == nil, let p = book.progression { sessionStart = (Date(), p) }
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
