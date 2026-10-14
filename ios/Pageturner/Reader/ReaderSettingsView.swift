import SwiftUI

struct ReaderSettingsView: View {
    @Binding var settings: ReaderSettings

    var body: some View {
        Form {
            Section("Theme") {
                ThemePicker(theme: $settings.theme)
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
                Toggle("Justify text", isOn: $settings.justify)
            }

            Section("Layout") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Margins")
                        .font(.subheadline)
                    Slider(value: $settings.margins, in: 0.5 ... 2, step: 0.25)
                }
                Toggle("Scroll instead of pages", isOn: $settings.scroll)
                if !settings.scroll {
                    Picker("Page layout", selection: $settings.columns) {
                        ForEach(ReaderSettings.Columns.allCases) {
                            Text($0.label).tag($0)
                        }
                    }
                    Picker("Page turn", selection: $settings.pageTurn) {
                        ForEach(PageTurnStyle.allCases) { Text($0.label).tag($0) }
                    }
                }
                Toggle("Keep the screen on", isOn: $settings.keepAwake)
            }

            Section("Read aloud") {
                ReadAloudControls(rate: $settings.speechRate, voice: $settings.voiceIdentifier)
            }

            Section {
                ReadAloudHighlightRows(highlights: $settings.highlights)
            } header: {
                Text("Highlight as it reads")
            } footer: {
                Text(ReadAloudHighlightRows.footnote)
            }
        }
    }
}

/// The five page palettes as little "Aa" tiles, in the colours they will have.
private struct ThemePicker: View {
    @Binding var theme: ReaderSettings.ThemeChoice

    var body: some View {
        HStack(spacing: 10) {
            ForEach(ReaderSettings.ThemeChoice.allCases) { choice in
                let selected = theme == choice
                Button { theme = choice } label: {
                    VStack(spacing: 6) {
                        Text("Aa")
                            .font(.system(.title3, design: .serif).weight(.semibold))
                            .foregroundStyle(Color(rgb: choice.text))
                            .frame(maxWidth: .infinity)
                            .frame(height: 52)
                            .background(Color(rgb: choice.background), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(
                                        selected ? Color.ptAccent : Color.secondary.opacity(0.35),
                                        lineWidth: selected ? 3 : 1))
                        Text(choice.label)
                            .font(.caption2)
                            .foregroundStyle(selected ? Color.primary : Color.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(choice.label)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
    }
}
