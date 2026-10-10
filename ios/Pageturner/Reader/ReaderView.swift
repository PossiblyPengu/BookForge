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
        ZStack {
            content
            if model.phase == .ready {
                VStack(spacing: 0) {
                    if model.showChrome { header.transition(.move(edge: .top).combined(with: .opacity)) }
                    Spacer(minLength: 0)
                    if let readAloud = model.readAloud, readAloud.isActive {
                        ReadAloudBar(
                            readAloud: readAloud,
                            rate: model.settings.speechRate,
                            onRate: { model.cycleRate() },
                            onStop: { model.stopReadAloud() }
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    } else if model.showChrome {
                        footer.transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
            }
        }
        .statusBarHidden(!model.showChrome)
        .animation(.smooth(duration: 0.25), value: model.showChrome)
        .animation(.smooth(duration: 0.25), value: model.readAloud?.isActive)
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

    /// Back, the title, and the page's tools — floating on glass over the page.
    private var header: some View {
        PTGlassGroup(spacing: 10) {
            HStack(spacing: 10) {
                PTIconButton(systemImage: "chevron.left", label: "Back to library") { dismiss() }

                VStack(spacing: 0) {
                    Text(model.book.title)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if let chapter = model.chapterTitle ?? (model.book.author.isEmpty ? nil : model.book.author) {
                        Text(chapter)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .ptGlassCapsule()
                .accessibilityElement(children: .combine)

                HStack(spacing: 0) {
                    if model.isSearchable {
                        toolButton("magnifyingglass", label: "Search in book") { showSearch = true }
                    }
                    toolButton(
                        model.isCurrentLocationBookmarked ? "bookmark.fill" : "bookmark",
                        label: model.isCurrentLocationBookmarked ? "Remove bookmark" : "Add bookmark"
                    ) { model.toggleBookmark() }
                    toolButton("list.bullet", label: "Contents, bookmarks and highlights") { showContents = true }
                }
                .padding(.horizontal, 4)
                .ptGlassCapsule()
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
        }
    }

    /// Text settings, how far along you are, and read aloud.
    private var footer: some View {
        PTGlassGroup(spacing: 10) {
            HStack(spacing: 10) {
                PTIconButton(systemImage: "textformat.size", label: "Reading settings") { showSettings = true }

                HStack(spacing: 10) {
                    Text("\(Int(((model.book.progression ?? 0) * 100).rounded()))%")
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                    ProgressView(value: min(max(model.book.progression ?? 0, 0), 1))
                        .tint(.ptAccent)
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .ptGlassCapsule()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Progress")
                .accessibilityValue("\(Int(((model.book.progression ?? 0) * 100).rounded())) percent")

                if model.canReadAloud {
                    PTIconButton(
                        systemImage: model.readAloud != nil ? "speaker.wave.2.fill" : "speaker.wave.2",
                        label: "Read aloud"
                    ) { model.toggleReadAloud() }
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
        }
    }

    private func toolButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .frame(width: 42, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityLabel(label)
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
        HStack(spacing: 4) {
            barButton("backward.fill", label: "Previous sentence") { readAloud.previous() }
            barButton(readAloud.isPlaying ? "pause.fill" : "play.fill", label: readAloud.isPlaying ? "Pause" : "Play", large: true) {
                readAloud.playPause()
            }
            barButton("forward.fill", label: "Next sentence") { readAloud.next() }

            Button(action: onRate) {
                Text(String(format: "%.3g×", rate))
                    .font(.subheadline.weight(.medium).monospacedDigit())
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Speaking speed")

            Menu {
                Button("Off") { readAloud.setSleepTimer(minutes: nil) }
                ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                    Button("\(minutes) minutes") { readAloud.setSleepTimer(minutes: minutes) }
                }
            } label: {
                Group {
                    if let left = readAloud.sleepRemaining {
                        // ceil — "5:00 left" shows 5m until it drops under 4:00
                        Text("\(Int(left / 60) + 1)m").font(.subheadline.monospacedDigit())
                    } else {
                        Image(systemName: "moon")
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Sleep timer")

            barButton("xmark", label: "Stop reading aloud", action: onStop)
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 10)
        .ptGlassCapsule()
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private func barButton(_ symbol: String, label: String, large: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(large ? .title2 : .body)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
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
