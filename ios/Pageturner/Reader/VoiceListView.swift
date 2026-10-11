import SwiftUI
import UIKit

/// Every voice iOS has installed, by language, with a sample button on each. Used by
/// Settings and by the reader (the Reading sheet and the read-aloud bar).
struct VoiceListView: View {
    /// The chosen voice's identifier; nil is Automatic.
    @Binding var selection: String?
    /// How fast the samples are spoken.
    let rate: Double

    @State private var voices: [SpeechVoice] = []
    @State private var looked = false
    @State private var query = ""
    @StateObject private var preview = SpeechPreview()

    var body: some View {
        let groups = SpeechVoices.groups(
            voices, query: query, preferred: Locale.preferredLanguages,
            languageName: Self.languageName, regionName: Self.regionName)
        return List {
            if query.isEmpty { automatic }
            if voices.isEmpty && looked {
                none
            } else {
                ForEach(groups) { group in
                    Section(group.title) {
                        ForEach(group.voices) { row($0) }
                    }
                }
            }
            if !query.isEmpty && groups.isEmpty && !voices.isEmpty {
                ContentUnavailableView.search(text: query)
            }
            more
        }
        .searchable(text: $query, prompt: "Search voices")
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        // coming back from iOS Settings after downloading a voice
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await load() }
        }
        .onDisappear { preview.stop() }
        .tint(.ptAccent)
    }

    // MARK: Sections

    private var automatic: some View {
        Section {
            HStack(spacing: 8) {
                Button { selection = nil } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Automatic").foregroundStyle(.primary)
                            Text("The best voice installed for each book’s language")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if selection == nil { chosenMark }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                sampleButton(nil)
            }
        }
    }

    private var none: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Label("No voices found", systemImage: "waveform.slash")
                    .font(.headline)
                Text("iOS hasn’t listed any voices yet. Give it a moment and look again — and if there are still none, add one under Settings → Accessibility → Spoken Content → Voices.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Look Again") { Task { await load() } }
                    .buttonStyle(.bordered)
            }
            .padding(.vertical, 6)
        }
    }

    private var more: some View {
        Section {
            Text("Enhanced and Premium voices sound far more natural. To add one, open Settings → Accessibility → Spoken Content → Voices (Read & Speak on newer iOS), choose a language and voice, and tap the download button. It appears here the next time you come back.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Rows

    private func row(_ voice: SpeechVoice) -> some View {
        HStack(spacing: 8) {
            Button { selection = voice.id } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(voice.displayName).foregroundStyle(.primary)
                        Text(detail(voice))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    if let badge = voice.quality.badge { QualityBadge(text: badge, premium: voice.quality == .premium) }
                    if selection == voice.id { chosenMark }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selection == voice.id ? .isSelected : [])
            sampleButton(voice)
        }
    }

    private var chosenMark: some View {
        Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.ptAccent)
            .accessibilityHidden(true)
    }

    private func sampleButton(_ voice: SpeechVoice?) -> some View {
        let playing = preview.playing == (voice?.id ?? "")
        return Button { preview.toggle(voice, rate: rate) } label: {
            Image(systemName: playing ? "stop.circle.fill" : "play.circle")
                .font(.title2)
                .foregroundStyle(Color.ptAccent)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(playing ? "Stop sample" : "Hear \(voice?.displayName ?? "the automatic voice")")
    }

    /// "United States", or the language tag when the voice has no region.
    private func detail(_ voice: SpeechVoice) -> String {
        SpeechVoices.region(voice.language).flatMap(Self.regionName) ?? voice.language
    }

    // MARK: Loading

    private func load() async {
        // right after launch iOS can answer with an empty list for a moment
        for _ in 0..<5 {
            voices = SystemVoices.readable()
            if !voices.isEmpty { break }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        looked = true
    }

    // MARK: Names

    private static func languageName(_ code: String) -> String {
        (Locale.current.localizedString(forLanguageCode: code) ?? code).localizedCapitalized
    }

    private static func regionName(_ code: String) -> String? {
        Locale.current.localizedString(forRegionCode: code)
    }
}

private struct QualityBadge: View {
    let text: String
    let premium: Bool

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(premium ? Color.ptAccent : Color.secondary)
            .background((premium ? Color.ptAccent : Color.secondary).opacity(0.15), in: Capsule())
            .accessibilityLabel(text)
    }
}

/// Speed, voice and a sample — the same rows in Settings and in the reader's Reading sheet.
/// Put inside a `Form` (or `List`) that sits in a `NavigationStack`.
struct ReadAloudControls: View {
    @Binding var rate: Double
    /// The chosen voice's identifier; nil is Automatic.
    @Binding var voice: String?

    @StateObject private var preview = SpeechPreview()
    @State private var installed: [SpeechVoice] = []

    var body: some View {
        Stepper(value: $rate, in: SpeechRateMap.range, step: SpeechRateMap.step) {
            LabeledContent("Speed", value: SpeechRateMap.label(rate))
        }
        NavigationLink {
            VoiceListView(selection: $voice, rate: rate)
        } label: {
            LabeledContent("Voice", value: voiceName)
        }
        Button { preview.toggle(chosen, rate: rate) } label: {
            Label(
                preview.playing == nil ? "Hear This Voice" : "Stop",
                systemImage: preview.playing == nil ? "play.fill" : "stop.fill")
        }
        .onAppear { installed = SystemVoices.installed() }
        .onDisappear { preview.stop() }
    }

    private var chosen: SpeechVoice? {
        voice.flatMap { id in installed.first { $0.id == id } }
    }

    /// A voice that has since been removed from the phone reads as Automatic.
    private var voiceName: String {
        chosen?.displayName ?? "Automatic"
    }
}
