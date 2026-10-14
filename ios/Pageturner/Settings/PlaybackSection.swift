import SwiftUI

/// Settings → Playback: the skip distances on the player's buttons (the same
/// ones the lock screen and headsets use), and the speed new listening starts
/// at — changed mid-listen it applies at once.
struct PlaybackSection: View {
    @AppStorage("audio-skip-back") private var back = 15.0
    @AppStorage("audio-skip-fwd") private var fwd = 30.0
    @AppStorage("audioPlaybackRate") private var rate = 1.0

    /// Every choice needs a `gobackward.N`/`goforward.N` symbol: those exist for
    /// 10, 15, 30, 45, 60, 75 and 90.
    private static let skips = [10.0, 15, 30, 45, 60]
    /// The same list the player's speed chip offers.
    private static let rates = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

    var body: some View {
        Section {
            Picker("Skip back", selection: $back) {
                ForEach(Self.skips, id: \.self) { Text("\(Int($0)) seconds").tag($0) }
            }
            Picker("Skip forward", selection: $fwd) {
                ForEach(Self.skips, id: \.self) { Text("\(Int($0)) seconds").tag($0) }
            }
            Picker("Speed", selection: $rate) {
                ForEach(Self.rates, id: \.self) { Text(Self.speed($0)).tag($0) }
            }
        } header: {
            Text("Playback")
        } footer: {
            Text("The same skips answer the lock screen and your headset.")
        }
        .onChange(of: rate) { _, r in
            PlaybackCoordinator.shared.player?.rate = Float(r)
        }
    }

    /// "1x", "1.25x" — the player's own phrasing.
    private static func speed(_ rate: Double) -> String { String(format: "%.3gx", rate) }
}
