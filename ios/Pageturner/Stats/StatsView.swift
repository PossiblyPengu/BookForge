import SwiftUI

/// Reading time and streaks from this phone. BookMaster's own numbers are on the BookMaster tab.
struct StatsView: View {
    /// Inside a tab: no Done button, the tab bar is the way out.
    var embedded = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                LocalStatsSection()
            }
            .navigationTitle("Reading Stats")
            .navigationBarTitleDisplayMode(embedded ? .large : .inline)
            .toolbar {
                if !embedded {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .onAppear { if embedded { BookMaster.shared.place = "stats" } }
            .onDisappear { if embedded { BookMaster.shared.place = "library" } }
        }
    }
}
