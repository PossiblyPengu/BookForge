import AVFoundation
import SwiftUI

struct ReaderSettingsView: View {
    @Binding var settings: ReaderSettings

    var body: some View {
        Form {
            Section("Theme") {
                Picker("Theme", selection: $settings.theme) {
                    ForEach(ReaderSettings.ThemeChoice.allCases) {
                        Text($0.label).tag($0)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            Section("Type") {
                Picker("Font", selection: $settings.font) {
                    ForEach(ReaderSettings.FontChoice.allCases) {
                        Text($0.label).tag($0)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Size")
                        .font(.subheadline)
                    Slider(value: $settings.fontSize, in: 0.7 ... 2, step: 0.1)
                }
                Picker("Line spacing", selection: $settings.spacing) {
                    ForEach(ReaderSettings.Spacing.allCases) {
                        Text($0.label).tag($0)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Margins")
                        .font(.subheadline)
                    Slider(value: $settings.margins, in: 0.5 ... 2, step: 0.25)
                }
                Toggle("Justify text", isOn: $settings.justify)
                Toggle("Scroll instead of pages", isOn: $settings.scroll)
            }

            Section("Read aloud") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Speed: \(String(format: "%.3g", settings.speechRate))×")
                        .font(.subheadline)
                    Slider(value: $settings.speechRate, in: 0.5 ... 2.5, step: 0.25)
                }
                NavigationLink {
                    VoicePicker(identifier: $settings.voiceIdentifier)
                } label: {
                    HStack {
                        Text("Voice")
                        Spacer()
                        Text(voiceName)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private var voiceName: String {
        guard let id = settings.voiceIdentifier,
              let voice = AVSpeechSynthesisVoice(identifier: id)
        else { return "Automatic" }
        return voice.name
    }
}

private struct VoicePicker: View {
    @Binding var identifier: String?
    @State private var query = ""

    private var grouped: [(String, [AVSpeechSynthesisVoice])] {
        var voices = AVSpeechSynthesisVoice.speechVoices()
        if !query.isEmpty {
            voices = voices.filter {
                $0.name.localizedCaseInsensitiveContains(query)
                    || $0.language.localizedCaseInsensitiveContains(query)
            }
        }
        return Dictionary(grouping: voices) {
            Locale.current.localizedString(forLanguageCode: $0.language) ?? $0.language
        }
        .sorted { $0.key < $1.key }
        .map { ($0.key, $0.value.sorted { $0.name < $1.name }) }
    }

    var body: some View {
        List {
            Section {
                row(name: "Automatic", id: nil as String?)
            }
            ForEach(grouped, id: \.0) { language, voices in
                Section(language) {
                    ForEach(voices, id: \.identifier) { voice in
                        row(name: voice.name, id: voice.identifier as String?)
                    }
                }
            }
        }
        .searchable(text: $query)
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(name: String, id: String?) -> some View {
        Button { identifier = id } label: {
            HStack {
                Text(name).foregroundStyle(.primary)
                Spacer()
                if id == identifier {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
        }
    }
}
