import SwiftUI

/// The app's frame: tabs, the mini player docked above them, and everything
/// that presents over the tabs. On iOS 26 the tab bar and its mini player are
/// Liquid Glass and the bar shrinks as you scroll; before that it is a plain
/// tab bar with the mini player above it.
struct RootView: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var router = AppRouter()
    private let playback = PlaybackCoordinator.shared
    private let bookMaster = BookMaster.shared
    private let notifier = Notifier.shared
    private let intents = IntentRouter.shared

    var body: some View {
        // grouped, so no one expression is a long chain the compiler has to solve at once
        routing(alerts(bookSheets(shell)))
            .tint(.ptAccent)
            // outermost, so the tabs and everything presented over them can read it
            .environment(router)
    }

    /// Requests that arrive from outside: a tapped suggestion notification, Siri,
    /// Shortcuts, a Spotlight result.
    private func routing<V: View>(_ content: V) -> some View {
        content
            .onChange(of: notifier.openTogether, initial: true) { _, open in
                guard open else { return }
                router.tab = .together
                notifier.openTogether = false
            }
            .onChange(of: intents.request, initial: true) { _, request in
                guard let request else { return }
                intents.request = nil
                handle(request)
            }
            #if DEBUG
            // CI simulator run: launch arguments choose a screen (Debug/DebugScenario.swift)
            .task { await DebugScenario.run(library: library, router: router) { router.tab = $0 } }
            #endif
    }

    private func handle(_ request: IntentRouter.Request) {
        switch request {
        case let .open(id):
            guard let book = library.books.first(where: { $0.id == id }) else { return }
            router.open(book, library: library)
        case .continueReading:
            guard let book = library.continueBook else { return }
            router.open(book, library: library)
        }
    }

    // MARK: Presentations

    /// A book's detail, its edit form, shelves and Settings.
    private func bookSheets<V: View>(_ content: V) -> some View {
        @Bindable var r = router
        return content
            .sheet(item: $r.detail) { book in detailSheet(book) }
            .sheet(item: $r.editing) { book in editSheet(book) }
            .sheet(item: $r.shelfTarget) { ShelvesSheet(target: $0) }
            .sheet(isPresented: $r.showSettings) { SettingsView() }
            .sheet(isPresented: $r.showLink) { linkSheet }
    }

    /// BookMaster's sign-in; the code it ends with is spent here and the shelf pulled.
    private var linkSheet: some View {
        BookMasterLinkSheet(
            onCode: { code in
                router.showLink = false
                Task {
                    if let message = await BookMasterLinker.shared.finish(code: code) {
                        bookMaster.notice = "Couldn’t link BookMaster: \(message)"
                    } else {
                        await bookMaster.pullShelf(into: library)
                        await bookMaster.pushCovers(from: library)
                        await bookMaster.beat()
                    }
                }
            },
            onCancel: { router.showLink = false })
    }

    private func detailSheet(_ book: Book) -> some View {
        BookDetailSheet(book: book, cover: library.cover(for: book)) {
            router.detail = nil
            // "Read again" starts from the beginning, not the last page
            if (book.progression ?? 0) >= 0.995 { library.restart(book.id) }
            router.open(library.books.first { $0.id == book.id } ?? book, library: library)
        } onEdit: {
            router.detail = nil
            // present the edit sheet after this one is fully dismissed
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { router.editing = book }
        } onDelete: {
            router.detail = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { router.askDelete([book]) }
        } onShelves: {
            router.detail = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { router.openShelves([book.id]) }
        } onFinish: {
            library.markFinished(book.id)
            router.detail = nil
        } onRestart: {
            library.restart(book.id)
            router.detail = nil
        } onRate: { stars in
            library.rate(book.id, stars: stars)
        }
    }

    private func editSheet(_ book: Book) -> some View {
        BookEditSheet(book: book) { updated in
            library.update(updated)
            // a lookup that named a BookMaster shelf row pins the book to it
            if let pin = updated.bookmasterId, pin != book.bookmasterId {
                library.updateBookMaster(book.id) { $0.bookmasterId = pin }
            }
            router.editing = nil
        }
    }

    /// BookMaster's notice, the "continue from BookMaster?" question and the remove confirmation.
    private func alerts<V: View>(_ content: V) -> some View {
        content
            .alert("BookMaster", isPresented: noticeShown) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(bookMaster.notice ?? "")
            }
            .alert(
                "Continue from BookMaster?",
                isPresented: resumeShown,
                presenting: router.resumePrompt
            ) { prompt in
                Button("Go to \(ResumeOffer.label(prompt.fraction))") {
                    router.answer(prompt, jump: true, library: library)
                }
                Button("Stay at \(ResumeOffer.label(prompt.book.progression ?? 0))") {
                    router.answer(prompt, jump: false, library: library)
                }
                Button("Cancel", role: .cancel) {}
            } message: { prompt in
                Text(Self.resumeMessage(prompt))
            }
            .confirmationDialog(
                Self.deleteTitle(router.pendingDelete),
                isPresented: deleteShown,
                titleVisibility: .visible,
                presenting: router.pendingDelete.isEmpty ? nil : router.pendingDelete
            ) { books in
                Button(books.count == 1 ? "Remove from Library" : "Remove \(books.count) Books", role: .destructive) {
                    for book in books {
                        if playback.bookID == book.id { playback.stop() }
                        library.delete(book)
                    }
                }
            } message: { _ in
                Text("This also deletes the file from this device. Your BookMaster shelf isn’t touched.")
            }
    }

    private var noticeShown: Binding<Bool> {
        Binding(get: { bookMaster.notice != nil }, set: { if !$0 { bookMaster.notice = nil } })
    }

    private var resumeShown: Binding<Bool> {
        Binding(get: { router.resumePrompt != nil }, set: { if !$0 { router.resumePrompt = nil } })
    }

    private var deleteShown: Binding<Bool> {
        Binding(get: { !router.pendingDelete.isEmpty }, set: { if !$0 { router.pendingDelete = [] } })
    }

    private static func resumeMessage(_ prompt: ResumePrompt) -> String {
        let remote = ResumeOffer.label(prompt.fraction)
        let here = ResumeOffer.label(prompt.book.progression ?? 0)
        return "BookMaster has you \(remote) of the way through “\(prompt.book.title)”. This device is at \(here)."
    }

    private static func deleteTitle(_ books: [Book]) -> String {
        books.count == 1 ? "Remove “\(books[0].title)”?" : "Remove \(books.count) books?"
    }

    // MARK: Shells

    @ViewBuilder
    private var shell: some View {
        // the bottom accessory can be switched off from iOS 26.1
        if #available(iOS 26.1, *) {
            modernShell
        } else {
            classicShell
        }
    }

    @available(iOS 26.1, *)
    private var modernShell: some View {
        @Bindable var r = router
        return TabView(selection: $r.tab) {
            Tab("Reading", systemImage: "book", value: AppTab.reading) {
                ReadingTabView()
            }
            Tab("Library", systemImage: "books.vertical", value: AppTab.library) {
                LibraryView()
            }
            Tab("BookMaster", systemImage: "bookmark.circle", value: AppTab.together) {
                togetherTab
            }
            .badge(notifier.pendingCount)
            Tab("Search", systemImage: "magnifyingglass", value: AppTab.search, role: .search) {
                SearchTab()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory(isEnabled: showMiniPlayer) { miniPlayer }
    }

    private var classicShell: some View {
        @Bindable var r = router
        return TabView(selection: $r.tab) {
            withMiniPlayer(ReadingTabView())
                .tabItem { Label("Reading", systemImage: "book") }
                .tag(AppTab.reading)
            withMiniPlayer(LibraryView())
                .tabItem { Label("Library", systemImage: "books.vertical") }
                .tag(AppTab.library)
            withMiniPlayer(togetherTab)
                .tabItem { Label("BookMaster", systemImage: "bookmark.circle") }
                .badge(notifier.pendingCount)
                .tag(AppTab.together)
            withMiniPlayer(SearchTab())
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(AppTab.search)
        }
    }

    // MARK: Pieces

    /// The mini player steps aside while the full player fills the Reading
    /// tab; reading an ebook with audio going keeps it, as the way back.
    private var showMiniPlayer: Bool {
        playback.player != nil && !(router.tab == .reading && router.reading == nil)
    }

    @ViewBuilder
    private var miniPlayer: some View {
        if let player = playback.player {
            MiniPlayer(player: player) { router.tab = .reading }
        }
    }

    /// Before iOS 26 there is no bottom accessory, so the mini player rides
    /// above the tab bar as an inset of each tab.
    private func withMiniPlayer<V: View>(_ content: V) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if showMiniPlayer, let player = playback.player {
                MiniPlayer(player: player) { router.tab = .reading }
                    .padding(.vertical, 8)
                    .background(.bar)
            }
        }
    }

    /// Tracking: this phone's reading time always, BookMaster's side once it is linked.
    private var togetherTab: some View {
        BookMasterView(embedded: true)
    }
}

