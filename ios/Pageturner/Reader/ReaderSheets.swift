import SwiftUI

/// A footnote or endnote, shown where the reader is instead of jumping to the
/// end of the chapter and losing the place.
struct FootnoteSheet: View {
    let note: Footnote
    let onGo: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(note.text)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                    .textSelection(.enabled)
            }
            .navigationTitle(note.label.map { "Note \($0)" } ?? "Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Go to Note", action: onGo)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.height(280), .large])
        .presentationDragIndicator(.visible)
    }
}

/// A highlight's colour and note — opened by tapping the highlight in the page.
struct HighlightEditorSheet: View {
    let highlight: Highlight
    /// Whether the account is linked, so "send to BookMaster" makes sense.
    let canQuote: Bool
    let onSave: (HighlightColor, String) -> Void
    let onDelete: () -> Void
    let onQuote: () async -> BookMaster.QuoteDelivery?

    @State private var color: HighlightColor
    @State private var note: String
    @State private var delivery: BookMaster.QuoteDelivery?
    @State private var sending = false
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    init(
        highlight: Highlight, canQuote: Bool,
        onSave: @escaping (HighlightColor, String) -> Void,
        onDelete: @escaping () -> Void,
        onQuote: @escaping () async -> BookMaster.QuoteDelivery?
    ) {
        self.highlight = highlight
        self.canQuote = canQuote
        self.onSave = onSave
        self.onDelete = onDelete
        self.onQuote = onQuote
        _color = State(initialValue: HighlightColor(saved: highlight.color))
        _note = State(initialValue: highlight.note ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(highlight.text.isEmpty ? "Highlight" : highlight.text)
                        .font(.callout)
                        .lineLimit(8)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) {
                            Capsule().fill(color.color).frame(width: 4)
                        }
                }
                Section("Colour") {
                    HStack(spacing: 14) {
                        ForEach(HighlightColor.allCases) { choice in
                            Button { color = choice } label: {
                                Circle()
                                    .fill(choice.color)
                                    .frame(width: 34, height: 34)
                                    .overlay {
                                        if color == choice {
                                            Image(systemName: "checkmark")
                                                .font(.footnote.weight(.bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(choice.label)
                            .accessibilityAddTraits(color == choice ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, 2)
                }
                Section("Note") {
                    TextField("Add a note", text: $note, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section {
                    if canQuote {
                        Button {
                            sending = true
                            Task {
                                delivery = await onQuote()
                                sending = false
                            }
                        } label: {
                            HStack {
                                Text("Send to BookMaster as a Quote")
                                if sending { Spacer(); ProgressView() }
                            }
                        }
                        // once it is sent or parked for later, a second tap would post it again
                        .disabled(sending || delivery == .sent || delivery == .queued)
                    }
                    Button("Delete Highlight", role: .destructive) {
                        if note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            onDelete()
                            dismiss()
                        } else {
                            confirmDelete = true
                        }
                    }
                } footer: {
                    if let delivery {
                        Text(delivery.message)
                            .foregroundStyle(delivery == .failed ? Color.red : Color.secondary)
                    }
                }
            }
            .navigationTitle("Highlight")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Delete this highlight and its note?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Highlight", role: .destructive) {
                    onDelete()
                    dismiss()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // Done, or a swipe away: either way what was chosen is kept (a deleted
        // highlight is gone by now, so this finds nothing to save)
        .onDisappear { onSave(color, note) }
    }
}
