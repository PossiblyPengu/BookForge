import ReadiumNavigator
import ReadiumShared
import SwiftUI

struct ReaderView: View {
    @StateObject private var model: ReaderModel
    @Environment(\.dismiss) private var dismiss
    @State private var showContents = false
    @State private var showSettings = false

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
            .onDisappear { model.stopReadAloud() }
            .sheet(isPresented: $showContents) { contentsSheet }
            .sheet(isPresented: $showSettings) { settingsSheet }
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
                if model.toc.isEmpty {
                    Text("No table of contents.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        OutlineRows(links: model.toc, depth: 0) { link in
                            showContents = false
                            model.go(to: link)
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
        HStack(spacing: 30) {
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
                    .frame(minWidth: 44)
            }
            Button(action: onStop) {
                Image(systemName: "xmark")
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
    }
}
