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
        .task(id: player.coverImage == nil) {
            if let color = player.coverImage?.averageColor { tint = Color(color) }
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
                if player.trackCount > 1 {
                    Menu("Tracks") {
                        ForEach(Array(player.trackNames.enumerated()), id: \.offset) { index, name in
                            Button {
                                player.goToTrack(index)
                            } label: {
                                if index == player.trackIndex {
                                    Label(name, systemImage: "checkmark")
                                } else {
                                    Text(name)
                                }
                            }
                        }
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
            if player.trackCount > 1, let name = player.trackNames[safe: player.trackIndex] {
                Text(name)
                    .font(.caption)
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
                Text("-" + format(max(player.duration - shownPosition, 0))).monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 32)
    }

    private var transport: some View {
        PTGlassGroup(spacing: 18) {
            HStack(spacing: 18) {
                transportButton("gobackward.15", label: "Back 15 seconds", size: 64) {
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
                transportButton("goforward.30", label: "Forward 30 seconds", size: 64) {
                    player.skip(by: 30)
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
            }
        }
    }

    private func chip(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.subheadline.weight(.medium).monospacedDigit())
            .foregroundStyle(.primary)
            .padding(.horizontal, 16)
            .frame(height: 40)
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

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
