import SwiftUI

/// Settings → Read Aloud: the speed and voice used whenever a book is read aloud.
/// (The reader's Reading sheet edits the same two values.)
struct ReadAloudSection: View {
    @State private var rate: Double
    @State private var voice: String?
    private let store = NeuralVoiceStore.shared

    init() {
        let settings = ReaderSettings.load()
        _rate = State(initialValue: settings.speechRate)
        _voice = State(initialValue: settings.voiceIdentifier)
    }

    var body: some View {
        Section {
            ReadAloudControls(rate: $rate, voice: $voice)
            NavigationLink {
                SavedVoicesView(selection: $voice)
            } label: {
                LabeledContent("Saved Voices", value: NeuralVoiceSummary.text(for: store))
            }
        } header: {
            Text("Read Aloud")
        } footer: {
            Text("Choose a voice from this iPhone, or a neural one — it downloads once (about 63 MB), sounds more natural and keeps reading with the screen locked. Automatic picks the best installed voice for each book’s language; Enhanced and Premium device voices can be added under Settings → Accessibility → Spoken Content → Voices.")
        }
        .onChange(of: rate) { _, _ in save() }
        .onChange(of: voice) { _, _ in save() }
    }

    /// Only the two read-aloud values, written over a fresh copy — the type settings are
    /// the reader's to change.
    private func save() {
        var settings = ReaderSettings.load()
        settings.speechRate = rate
        settings.voiceIdentifier = voice
        settings.save()
    }
}
