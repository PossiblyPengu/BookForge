import ReadiumNavigator
import ReadiumShared
import SwiftUI

struct ReaderView: View {
    @StateObject private var model: ReaderModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showContents = false
    @State private var showSettings = false
    @State private var showSearch = false

    init(book: Book, library: LibraryStore) {
        _model = StateObject(wrappedValue: ReaderModel(book: book, library: library))
    }

    var body: some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.showChrome, model.phase == .ready { header }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let readAloud = model.readAloud, readAloud.isActive {
                    ReadAloudBar(
                        readAloud: readAloud,
                        rate: model.settings.speechRate,
                        onRate: { model.cycleRate() },
                        onStop: { model.stopReadAloud() }
                    )
                }
            }
            .statusBarHidden(!model.showChrome)
            .animation(.default, value: model.showChrome)
            .task { await model.open() }
            .onChange(of: model.settings) { _ in model.applySettings() }
            .onAppear { BookMaster.shared.place = "reader" }
            .onDisappear {
                model.flushSave()
                model.endSession()
                model.stopReadAloud()
                BookMaster.shared.place = "library"
            }
            // a sitting ends when the app leaves the screen — not whenever it is next opened
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: model.flushSave(); model.endSession()
                case .active: model.beginSession()
                default: break
                }
            }
            .sheet(isPresented: $showContents) { contentsSheet }
            .sheet(isPresented: $showSettings) { settingsSheet }
            .sheet(isPresented: $showSearch) { searchSheet }
            .alert("Pageturner", isPresented: Binding(
                get: { model.notice != nil },
                set: { if !$0 { model.notice = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.notice ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView("Opening…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground).ignoresSafeArea())
        case .ready:
            if let controller = model.navigatorController {
                NavigatorRepresentable(controller: controller)
                    .ignoresSafeArea()
            }
        case let .failed(message):
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(message)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Back to Library") { dismiss() }
                    .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemBackground).ignoresSafeArea())
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 32, height: 32)
            }
            Spacer()
            VStack(spacing: 1) {
                Text(model.book.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if !model.book.author.isEmpty {
                    Text(model.book.author)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if model.canReadAloud {
                Button { model.toggleReadAloud() } label: {
                    Image(systemName: model.readAloud != nil ? "speaker.wave.2.fill" : "speaker.wave.2")
                        .frame(width: 32, height: 32)
                }
            }
            if model.isSearchable {
                Button { showSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                        .frame(width: 32, height: 32)
                }
            }
            Button { model.toggleBookmark() } label: {
                Image(systemName: model.isCurrentLocationBookmarked ? "bookmark.fill" : "bookmark")
                    .frame(width: 32, height: 32)
            }
            Button { showContents = true } label: {
                Image(systemName: "list.bullet")
                    .frame(width: 32, height: 32)
            }
            Button { showSettings = true } label: {
                Image(systemName: "textformat.size")
                    .frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
    }

    private var contentsSheet: some View {
        NavigationStack {
            Group {
                if model.toc.isEmpty, model.book.bookmarks.isEmpty, model.book.highlights.isEmpty {
                    Text("No table of contents.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        if !model.book.highlights.isEmpty {
                            Section("Highlights") {
                                ForEach(model.book.highlights.sorted { $0.createdAt > $1.createdAt }) { hl in
                                    Button {
                                        showContents = false
                                        model.goToHighlight(hl)
                                    } label: {
                                        Label {
                                            Text(hl.text.isEmpty ? "Highlight" : hl.text)
                                                .lineLimit(2)
                                                .foregroundStyle(.primary)
                                        } icon: {
                                            Image(systemName: "highlighter")
                                                .foregroundStyle(.yellow)
                                        }
                                    }
                                    .swipeActions {
                                        Button(role: .destructive) { model.removeHighlight(hl) } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                            }
                        }
                        if !model.book.bookmarks.isEmpty {
                            Section("Bookmarks") {
                                ForEach(model.book.bookmarks.sorted { $0.createdAt > $1.createdAt }) { bm in
                                    Button {
                                        showContents = false
                                        model.goToBookmark(bm)
                                    } label: {
                                        Label {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(bm.title).lineLimit(1)
                                                if let p = bm.progression {
                                                    Text("\(Int((p * 100).rounded()))% through")
                                                        .font(.caption)
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                        } icon: {
                                            Image(systemName: "bookmark.fill")
                                        }
                                        .foregroundStyle(.primary)
                                    }
                                    .swipeActions {
                                        Button(role: .destructive) { model.removeBookmark(bm) } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                            }
                        }
                        if !model.toc.isEmpty {
                            Section("Chapters") {
                                OutlineRows(links: model.toc, depth: 0) { link in
                                    showContents = false
                                    model.go(to: link)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Contents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showContents = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var searchSheet: some View {
        NavigationStack {
            SearchResultsView(model: model) {
                showSearch = false
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showSearch = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var settingsSheet: some View {
        NavigationStack {
            ReaderSettingsView(settings: $model.settings)
                .navigationTitle("Reading")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showSettings = false }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Hosts a Readium navigator (EPUB or PDF) inside SwiftUI.
private struct NavigatorRepresentable: UIViewControllerRepresentable {
    let controller: UIViewController

    func makeUIViewController(context: Context) -> UIViewController { controller }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}

private struct OutlineRows: View {
    let links: [ReadiumShared.Link]
    let depth: Int
    let onSelect: (ReadiumShared.Link) -> Void

    var body: some View {
        ForEach(Array(links.enumerated()), id: \.offset) { _, link in
            Button { onSelect(link) } label: {
                Text(link.title ?? "Untitled")
                    .padding(.leading, CGFloat(depth * 16))
                    .foregroundStyle(.primary)
            }
            OutlineRows(links: link.children, depth: depth + 1, onSelect: onSelect)
        }
    }
}

private struct ReadAloudBar: View {
    @ObservedObject var readAloud: ReadAloud
    let rate: Double
    let onRate: () -> Void
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 26) {
            Button { readAloud.previous() } label: {
                Image(systemName: "backward.fill")
            }
            Button { readAloud.playPause() } label: {
                Image(systemName: readAloud.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title2)
            }
            Button { readAloud.next() } label: {
                Image(systemName: "forward.fill")
            }
            Button(action: onRate) {
                Text(String(format: "%.3g×", rate))
                    .font(.subheadline.monospacedDigit())
                    .frame(minWidth: 40)
            }
            Menu {
                Button("Sleep: Off") { readAloud.setSleepTimer(minutes: nil) }
                ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                    Button("\(minutes) min") { readAloud.setSleepTimer(minutes: minutes) }
                }
            } label: {
                if let left = readAloud.sleepRemaining {
                    // ceil — "5:00 left" shows 5m until it drops under 4:00
                    Text("\(Int(left / 60) + 1)m")
                        .font(.subheadline.monospacedDigit())
                        .frame(minWidth: 30)
                } else {
                    Image(systemName: "moon")
                }
            }
            .accessibilityLabel("Sleep timer")
            Button(action: onStop) {
                Image(systemName: "xmark")
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
    }
}

private struct SearchResultsView: View {
    @ObservedObject var model: ReaderModel
    let onPick: () -> Void
    @State private var query = ""
    @State private var debounceTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search this book", text: $query)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .onSubmit { model.search(query) }
                if model.searchInFlight { ProgressView() }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            .padding([.horizontal, .top])

            List(Array(model.searchResults.enumerated()), id: \.offset) { i, locator in
                Button {
                    onPick()
                    model.go(to: locator)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(locator.title ?? "Match \(i + 1)")
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                        if let highlight = locator.text.highlight, !highlight.isEmpty {
                            Text("…\((locator.text.before ?? "").trimmingCharacters(in: .whitespaces)) \(highlight) \((locator.text.after ?? "").trimmingCharacters(in: .whitespaces))…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .listStyle(.plain)
            .overlay {
                if !model.searchInFlight, model.searchResults.isEmpty, !query.isEmpty {
                    Text("No matches")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .onChange(of: query) { q in
            debounceTask?.cancel()
            debounceTask = Task {
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard !Task.isCancelled else { return }
                model.search(q)
            }
        }
    }
}
