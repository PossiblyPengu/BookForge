import SwiftUI

/// A new goal: the kind BookMaster counts, a number to chase, and — for the
/// monthly kind — which month. Mirrors the web's goal card's form.
struct BMGoalSheet: View {
    /// Called after a goal lands so the parent can pull the numbers again.
    var onDone: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var kind: BMGoal.Kind = .yearlyBooks
    @State private var target = 24
    @State private var label = ""
    @State private var month = Calendar.current.component(.month, from: Date())
    @State private var saving = false
    @State private var error: String?

    private var thisYear: Int { Calendar.current.component(.year, from: Date()) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Goal", selection: $kind) {
                        ForEach(BMGoal.Kind.allCases) { Text($0.label).tag($0) }
                    }
                    Stepper("\(target) \(kind == .yearlyPages ? "pages" : "books")",
                            value: $target, in: 1...(kind == .yearlyPages ? 200_000 : 1_000))
                    if kind == .monthlyBooks {
                        Picker("Month", selection: $month) {
                            ForEach(1...12, id: \.self) {
                                Text(monthName($0)).tag($0)
                            }
                        }
                    }
                    TextField("Name (optional)", text: $label)
                } footer: {
                    Text(kind == .yearlyPages
                         ? "Counted against the pages BookMaster logs this year."
                         : "Counted against books marked finished.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("New goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await BookMaster.shared.setGoal(
                type: kind.rawValue,
                target: target,
                year: thisYear,
                month: kind == .monthlyBooks ? month : nil,
                label: label.trimmingCharacters(in: .whitespaces).isEmpty ? nil : label)
            onDone()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func monthName(_ month: Int) -> String {
        Calendar.current.monthSymbols[safe: month - 1] ?? "\(month)"
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
