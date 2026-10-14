import SwiftUI

/// Settings → Reading: page-turn and keep-awake, stored in ReaderSettings with
/// the rest — the same values the reader's own sheet edits. An open book keeps
/// the copy it loaded until it is opened again.
struct ReadingSection: View {
    @State private var pageTurn: PageTurnStyle
    @State private var keepAwake: Bool
    @AppStorage("readerShowsTimeLeft") private var showsTimeLeft = false

    init() {
        let s = ReaderSettings.load()
        _pageTurn = State(initialValue: s.pageTurn)
        _keepAwake = State(initialValue: s.keepAwake)
    }

    var body: some View {
        Section {
            Picker("Page turn", selection: $pageTurn) {
                ForEach(PageTurnStyle.allCases) { Text($0.label).tag($0) }
            }
            Toggle("Keep screen awake while reading", isOn: $keepAwake)
            Toggle("Show time left to finish", isOn: $showsTimeLeft)
        } header: {
            Text("Reading")
        } footer: {
            Text("Page turn and keep-awake apply to books opened from now on; the “time left” note — at this reader’s pace — follows the switch at once.")
        }
        .onChange(of: pageTurn) { _, _ in save() }
        .onChange(of: keepAwake) { _, _ in save() }
    }

    /// Only the defaults this section owns, written over a fresh copy — the
    /// read-aloud and type values are theirs to change.
    private func save() {
        var s = ReaderSettings.load()
        s.pageTurn = pageTurn
        s.keepAwake = keepAwake
        s.save()
    }
}
