import SwiftUI

/// The strip docked above the tab bar while an audiobook is loaded.
struct MiniPlayer: View {
    @ObservedObject var player: AudioPlayer
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpen) {
                HStack(spacing: 12) {
                    Group {
                        if let cover = player.coverImage {
                            Image(uiImage: cover).resizable().scaledToFill()
                        } else {
                            Image(systemName: "headphones")
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .background(Color.ptAccent.opacity(0.25))
                        }
                    }
                    .frame(width: 34, height: 34)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                    VStack(alignment: .leading, spacing: 0) {
                        Text(player.bookTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        if !player.bookAuthor.isEmpty {
                            Text(player.bookAuthor)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Now playing: \(player.bookTitle)")
            .accessibilityHint("Opens the player")

            Button { player.togglePlay() } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

            Button { player.skip(by: 30) } label: {
                Image(systemName: "goforward.30")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Skip forward 30 seconds")
        }
        .padding(.horizontal, 16)
    }
}
