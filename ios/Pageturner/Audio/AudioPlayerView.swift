import SwiftUI

/// Full-screen audiobook player — big cover, seek bar, transport controls,
/// speed + sleep timer. Mirrors the web player's layout.
struct AudioPlayerView: View {
    @StateObject private var player: AudioPlayer
    @Environment(\.dismiss) private var dismiss
    @State private var scrubbing: TimeInterval?

    init(book: Book, library: LibraryStore) {
        _player = StateObject(wrappedValue: AudioPlayer(book: book, library: library))
    }

    private var shownPosition: TimeInterval { scrubbing ?? player.position }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 44, height: 44)
                }
                Spacer()
            }
            .padding(.horizontal)

            Spacer()

            Group {
                if let cover = player.coverImage {
                    Image(uiImage: cover).resizable().scaledToFill()
                } else {
                    ZStack {
                        LinearGradient(colors: [.orange.opacity(0.7), .brown], startPoint: .top, endPoint: .bottom)
                        Image(systemName: "headphones")
                            .font(.system(size: 60))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                }
            }
            .frame(width: 260, height: 260)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
            .padding(.bottom, 24)

            Text(player.bookTitle)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
            if !player.bookAuthor.isEmpty {
                Text(player.bookAuthor)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if player.trackCount > 1 {
                Menu {
                    ForEach(Array(player.trackNames.enumerated()), id: \.offset) { i, name in
                        Button { player.goToTrack(i) } label: {
                            HStack {
                                Text(name).lineLimit(1)
                                if i == player.trackIndex {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(player.trackNames[safe: player.trackIndex]
                            ?? "Track \(player.trackIndex + 1) of \(player.trackCount)")
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }
            }

            Spacer()

            VStack(spacing: 4) {
                Slider(
                    value: Binding(
                        get: { shownPosition },
                        set: { scrubbing = $0 }
                    ),
                    in: 0...max(player.duration, 1),
                    onEditingChanged: { editing in
                        if !editing, let t = scrubbing {
                            player.seek(to: t, resume: player.isPlaying)
                            scrubbing = nil
                        }
                    }
                )
                .padding(.horizontal, 28)
                HStack {
                    Text(format(shownPosition)).monospacedDigit()
                    Spacer()
                    Text("-" + format(max(player.duration - shownPosition, 0))).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 30)
            }

            HStack(spacing: 44) {
                Button { player.skip(by: -15) } label: {
                    Image(systemName: "gobackward.15").font(.title)
                }
                Button { player.togglePlay() } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 66))
                }
                Button { player.skip(by: 30) } label: {
                    Image(systemName: "goforward.30").font(.title)
                }
            }
            .padding(.vertical, 22)

            HStack(spacing: 40) {
                Menu {
                    ForEach([0.75, 1.0, 1.25, 1.5, 1.75, 2.0], id: \.self) { r in
                        Button(String(format: "%.2gx", r)) { player.rate = Float(r) }
                    }
                } label: {
                    Text(String(format: "%.2gx", player.rate))
                        .font(.subheadline.monospacedDigit())
                        .frame(minWidth: 44)
                }
                Menu {
                    Button("Sleep: Off") { player.setSleepTimer(minutes: nil) }
                    ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                        Button("\(minutes) min") { player.setSleepTimer(minutes: minutes) }
                    }
                } label: {
                    if let left = player.sleepRemaining {
                        Text("\(Int(left / 60) + 1)m")
                            .font(.subheadline.monospacedDigit())
                            .frame(minWidth: 30)
                    } else {
                        Image(systemName: "moon")
                    }
                }
                .accessibilityLabel("Sleep timer")
            }
            .foregroundStyle(.secondary)
            .padding(.bottom, 30)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .task { await player.open() }
        .onDisappear { player.close() }
        .alert("Pageturner", isPresented: Binding(
            get: { player.notice != nil },
            set: { if !$0 { player.notice = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.notice ?? "")
        }
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
