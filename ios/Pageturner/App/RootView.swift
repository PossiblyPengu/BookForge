import SwiftUI

/// The app's frame: tabs, the mini player docked above them, and everything
/// that presents over the tabs. On iOS 26 the tab bar and its mini player are
/// Liquid Glass and the bar shrinks as you scroll; before that it is a plain
/// tab bar with the mini player above it.
struct RootView: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var router = AppRouter()
    @State private var tab: AppTab = .library
    private let playback = PlaybackCoordinator.shared
    private let bookMaster = BookMaster.shared

    var body: some View {
        @Bindable var router = router
        @Bindable var playback = playback
        shell
            .tint(.ptAccent)
            .fullScreenCover(item: $router.reading) { book in
                ReaderView(book: book, library: library)
            }
            .sheet(isPresented: $playback.showNowPlaying) {
                if let player = playback.player {
                    NowPlayingView(player: player) { playback.stop() }
                        .presentationDragIndicator(.visible)
                }
            }
            .sheet(item: $router.detail) { book in
                BookDetailSheet(book: book, cover: library.cover(for: book)) {
                    router.detail = nil
                    router.open(book, library: library)
                } onEdit: {
                    router.detail = nil
                    // present the edit sheet after this one is fully dismissed
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { router.editing = book }
                } onDelete: {
                    library.delete(book)
                    router.detail = nil
                }
            }
            .sheet(item: $router.editing) { book in
                BookEditSheet(book: book) { updated in
                    library.update(updated)
                    router.editing = nil
                }
            }
            .sheet(isPresented: $router.showSettings) { SettingsView() }
            .alert("BookMaster", isPresented: Binding(
                get: { bookMaster.notice != nil },
                set: { if !$0 { bookMaster.notice = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(bookMaster.notice ?? "")
            }
            // outermost, so the tabs and everything presented over them can read it
            .environment(router)
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
        TabView(selection: $tab) {
            Tab("Library", systemImage: "books.vertical", value: AppTab.library) {
                LibraryView()
            }
            Tab("Together", systemImage: "person.2", value: AppTab.together) {
                togetherTab
            }
            Tab("Stats", systemImage: "chart.bar", value: AppTab.stats) {
                statsTab
            }
            Tab("Search", systemImage: "magnifyingglass", value: AppTab.search, role: .search) {
                SearchTab()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory(isEnabled: playback.isActive) { miniPlayer }
    }

    private var classicShell: some View {
        TabView(selection: $tab) {
            withMiniPlayer(LibraryView())
                .tabItem { Label("Library", systemImage: "books.vertical") }
                .tag(AppTab.library)
            withMiniPlayer(togetherTab)
                .tabItem { Label("Together", systemImage: "person.2") }
                .tag(AppTab.together)
            withMiniPlayer(statsTab)
                .tabItem { Label("Stats", systemImage: "chart.bar") }
                .tag(AppTab.stats)
            withMiniPlayer(SearchTab())
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(AppTab.search)
        }
    }

    // MARK: Pieces

    @ViewBuilder
    private var miniPlayer: some View {
        if let player = playback.player {
            MiniPlayer(player: player) { playback.showNowPlaying = true }
        }
    }

    /// Before iOS 26 there is no bottom accessory, so the mini player rides
    /// above the tab bar as an inset of each tab.
    private func withMiniPlayer<V: View>(_ content: V) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if let player = playback.player {
                MiniPlayer(player: player) { playback.showNowPlaying = true }
                    .padding(.vertical, 8)
                    .background(.bar)
            }
        }
    }

    @ViewBuilder
    private var togetherTab: some View {
        if bookMaster.isLinked {
            TogetherView(embedded: true)
        } else {
            LinkPrompt(
                title: "Together",
                message: "Link BookMaster to see what the other reader is on and swap suggestions.",
                symbol: "person.2")
        }
    }

    @ViewBuilder
    private var statsTab: some View {
        if bookMaster.isLinked {
            StatsView(embedded: true)
        } else {
            LinkPrompt(
                title: "Stats",
                message: "Link BookMaster to see your streaks, goals and totals.",
                symbol: "chart.bar")
        }
    }
}

/// Shown on the BookMaster tabs until an account is linked.
private struct LinkPrompt: View {
    let title: String
    let message: String
    let symbol: String
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(title, systemImage: symbol)
            } description: {
                Text(message)
            } actions: {
                Button("Link BookMaster") { router.showSettings = true }
                    .ptButtonStyle(prominent: true)
            }
            .navigationTitle(title)
        }
    }
}
