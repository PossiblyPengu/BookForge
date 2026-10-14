import SwiftUI

/// Settings → Appearance: the app's own light or dark. The reader keeps its
/// page themes either way — this is the shell around the books.
struct AppearanceSection: View {
    @AppStorage("app-appearance") private var appearance = "system"

    var body: some View {
        Section {
            Picker("Appearance", selection: $appearance) {
                Text("Match iPhone").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        } header: {
            Text("Appearance")
        } footer: {
            Text("The reader keeps its own page themes; this is the app around the books.")
        }
    }
}
