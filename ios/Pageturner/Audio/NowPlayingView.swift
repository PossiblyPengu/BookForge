import SwiftUI

/// The full player: cover-tinted backdrop, big art, a seek bar, and the
/// transport controls as one glass cluster. Presented as a sheet over the app,
/// so the mini player and the library stay one swipe away.
struct NowPlayingView: View {
    @ObservedObject var player: AudioPlayer
    let onStop: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var scrubbing: TimeInterval?
    @State private var tint: Color = .ptAccent
    @State private var showChapters = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var shownPosition: TimeInterval { scrubbing ?? player.position }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 8)
            artwork
            Spacer(minLength: 8)
            titles
            Spacer(minLength: 8)
            scrubber
            transport
            extras
        }
        .padding(.bottom, 12)
        .background(backdrop)
        .onAppear { BookMaster.shared.place = "player" }
        .onDisappear { BookMaster.shared.place = "library" }
        #if DEBUG
        // CI simulator run: show the chapter list (Debug/DebugScenario.swift)
        .task {
            guard UserDefaults.standard.string(forKey: "PTDebugPlayerSheet") == "chapters" else { return }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            showChapters = true
        }
        #endif
        .task(id: player.coverImage == nil) {
            if let color = player.coverImage?.averageColor { tint = Color(color) }
        }
        .sheet(isPresented: $showChapters) {
            ChapterListSheet(player: player)
                .presentationDetents([.medium, .large])
        }
        .alert("Pageturner", isPresented: Binding(
            get: { player.notice != nil },
            set: { if !$0 { player.notice = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.notice ?? "")
        }
    }

    // MARK: Pieces

    private var backdrop: some View {
        LinearGradient(
            colors: [tint.opacity(0.55), tint.opacity(0.18), Color(.systemBackground)],
            startPoint: .top, endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    private var topBar: some View {
        HStack {
            PTIconButton(systemImage: "chevron.down", label: "Close player") { dismiss() }
            Spacer()
            Menu {
                if player.chapters.count > 1 {
                    Button { showChapters = true } label: {
                        Label("Chapters", systemImage: "list.bullet")
                    }
                }
                Button(role: .destructive) {
                    onStop()
                } label: {
                    Label("Stop and Close", systemImage: "stop.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                    .ptGlass(in: Circle(), interactive: true)
            }
            .accessibilityLabel("More")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var artwork: some View {
        Group {
            if let cover = player.coverImage {
                Image(uiImage: cover).resizable().scaledToFill()
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color.ptAccent.opacity(0.8), .brown],
                        startPoint: .top, endPoint: .bottom)
                    Image(systemName: "headphones")
                        .font(.system(size: 72))
                        .foregroundStyle(.white.opacity(0.9))
                }
            }
        }
        .frame(maxWidth: 300, maxHeight: 300)
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: tint.opacity(0.5), radius: 30, y: 14)
        .padding(.horizontal, 40)
        .accessibilityHidden(true)
    }

    private var titles: some View {
        VStack(spacing: 4) {
            Text(player.bookTitle)
                .font(.title3.weight(.bold))
                .multilineTextAlignment(.center)
                .lineLimit(2)
            if !player.bookAuthor.isEmpty {
                Text(player.bookAuthor)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let chapter = player.currentChapter, player.chapters.count > 1 {
                Text(chapter.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 28)
    }

    private var scrubber: some View {
        VStack(spacing: 2) {
            Slider(
                value: Binding(get: { shownPosition }, set: { scrubbing = $0 }),
                in: 0...max(player.duration, 1),
                onEditingChanged: { editing in
                    if !editing, let target = scrubbing {
                        player.seek(to: target, resume: player.isPlaying)
                        scrubbing = nil
                    }
                }
            )
            .tint(.ptAccent)
            .accessibilityLabel("Position")
            HStack {
                Text(format(shownPosition)).monospacedDigit()
                Spacer()
                if let chapter = player.currentChapter, player.chapters.count > 1 {
                    Text("\(format(max(chapter.end - shownPosition, 0))) left in chapter")
                        .monospacedDigit()
                    Spacer()
                }
                Text("-" + format(max(player.duration - shownPosition, 0))).monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 32)
    }

    private var transport: some View {
        let chapterSkips = player.chapters.count > 1
        return PTGlassGroup(spacing: 14) {
            HStack(spacing: chapterSkips ? 10 : 18) {
                if chapterSkips {
                    transportButton("backward.end.fill", label: "Previous chapter", size: 50) {
                        player.previousChapter()
                    }
                }
                transportButton("gobackward.15", label: "Back 15 seconds", size: chapterSkips ? 56 : 64) {
                    player.skip(by: -15)
                }
                Button { player.togglePlay() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 34, weight: .semibold))
                        .frame(width: 88, height: 88)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .ptGlass(in: Circle(), tint: .ptAccent.opacity(0.55), interactive: true)
                .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
                transportButton("goforward.30", label: "Forward 30 seconds", size: chapterSkips ? 56 : 64) {
                    player.skip(by: 30)
                }
                if chapterSkips {
                    transportButton("forward.end.fill", label: "Next chapter", size: 50) {
                        player.nextChapter()
                    }
                }
            }
        }
        .padding(.vertical, 18)
    }

    private func transportButton(
        _ symbol: String, label: String, size: CGFloat, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .medium))
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .ptGlass(in: Circle(), interactive: true)
        .accessibilityLabel(label)
    }

    private var extras: some View {
        PTGlassGroup(spacing: 12) {
            HStack(spacing: 12) {
                Menu {
                    ForEach([0.75, 1.0, 1.25, 1.5, 1.75, 2.0], id: \.self) { rate in
                        Button(String(format: "%.2gx", rate)) { player.rate = Float(rate) }
                    }
                } label: {
                    chip(String(format: "%.2gx", player.rate), symbol: "speedometer")
                }
                .accessibilityLabel("Playback speed")

                Menu {
                    Button("Off") { player.setSleepTimer(minutes: nil) }
                    ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                        Button("\(minutes) minutes") { player.setSleepTimer(minutes: minutes) }
                    }
                } label: {
                    if let left = player.sleepRemaining {
                        chip("\(Int(left / 60) + 1)m", symbol: "moon.fill")
                    } else {
                        chip("Sleep", symbol: "moon")
                    }
                }
                .accessibilityLabel("Sleep timer")

                if player.chapters.count > 1 {
                    Button { showChapters = true } label: {
                        chip("Chapters", symbol: "list.bullet")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Chapters")
                }
            }
        }
    }

    /// A glass pill with an icon and a word; just the icon once the text is large
    /// enough that three words won't fit in a row (each control has its own VoiceOver label).
    private func chip(_ text: String, symbol: String) -> some View {
        Group {
            if typeSize.isAccessibilitySize {
                Image(systemName: symbol)
                    .font(.title3)
                    .frame(minWidth: 56, minHeight: 48)
            } else {
                Label(text, systemImage: symbol)
                    .font(.subheadline.weight(.medium).monospacedDigit())
                    .padding(.horizontal, 16)
                    .frame(height: 40)
            }
        }
        .foregroundStyle(.primary)
        .ptGlassCapsule(interactive: true)
    }

    private func format(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.down))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, r)
            : String(format: "%d:%02d", m, r)
    }
}

/// Every chapter with where it starts; tap one to jump there.
private struct ChapterListSheet: View {
    @ObservedObject var player: AudioPlayer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List(player.chapters) { chapter in
                    let current = chapter.id == player.currentChapterIndex
                    Button {
                        player.goToChapter(chapter.id)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(chapter.title)
                                    .font(.body.weight(current ? .semibold : .regular))
                                    .foregroundStyle(current ? Color.ptAccent : Color.primary)
                                    .lineLimit(2)
                                Text(Self.format(chapter.length))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            if current {
                                Image(systemName: player.isPlaying ? "speaker.wave.2.fill" : "speaker.fill")
                                    .foregroundStyle(Color.ptAccent)
                                    .accessibilityHidden(true)
                            }
                            Text(Self.format(chapter.start))
                                .font(.callout.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .id(chapter.id)
                    .accessibilityAddTraits(current ? .isSelected : [])
                }
                .listStyle(.plain)
                .onAppear {
                    if let index = player.currentChapterIndex { proxy.scrollTo(index, anchor: .center) }
                }
            }
            .navigationTitle("Chapters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private static func format(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.down))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, r)
            : String(format: "%d:%02d", m, r)
    }
}
