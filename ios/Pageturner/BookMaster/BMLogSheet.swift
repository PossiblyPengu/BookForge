import SwiftUI

/// A session logged by hand — the web's "Log Reading Session" modal. Where
/// you got from and to (pages when BookMaster knows the count, percent else),
/// how long it took — typed or run on the sheet's own timer — and BookMaster
/// counts it like a sitting the reader logged itself.
struct BMLogSheet: View {
    let row: BMShelfRow
    /// Minutes a timer already ran — filled in when one is handed over.
    var initialMinutes: Int? = nil
    var onDone: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var start = 0.0
    @State private var end = 0.0
    @State private var minutes = ""
    @State private var error: String?
    @State private var saving = false
    // The sheet's own stopwatch for "time me while I read".
    @State private var timing = false
    @State private var elapsed: TimeInterval = 0
    @State private var startedAt: Date?

    /// Positions are pages when the book has a count, percent when it does not.
    private var paged: Bool { (row.totalPages ?? 0) > 0 }
    private var unit: String { paged ? "page" : "%" }
    private var ceiling: Double { paged ? Double(row.totalPages!) : 100 }

    private var current: Double {
        let pct = row.percent ?? 0
        return paged ? (pct / 100) * Double(row.totalPages!) : pct
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(row.title) {
                    field("From", value: $start)
                    field("To", value: $end)
                    if end > ceiling {
                        Text(paged ? "This book has \(Int(ceiling)) pages." : "100% is the top.")
                            .font(.caption).foregroundStyle(.red)
                    } else if end > start {
                        Text("+\(Int(end - start)) \(paged ? "pages" : "%")")
                            .font(.caption.weight(.semibold)).foregroundStyle(Color.ptAccent)
                    }
                }
                Section("How long") {
                    HStack {
                        TextField("Minutes (optional)", text: $minutes)
                            .keyboardType(.numberPad)
                        Spacer()
                        Button(timing ? "Stop" : "Time me") {
                            timing ? stop() : startTiming()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        if timing || elapsed > 0 {
                            Text(clock(elapsed))
                                .font(.callout.monospacedDigit())
                                .frame(minWidth: 56)
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Log a session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving || end <= start || end > ceiling)
                }
            }
            .onAppear {
                start = current
                end = min(current + (paged ? 30 : 10), ceiling)
                if let initialMinutes { minutes = "\(initialMinutes)" }
            }
            .onReceive(Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()) { _ in
                if let startedAt, timing { elapsed = Date().timeIntervalSince(startedAt) }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// One labelled numeric field — pages or percent, whichever the book takes.
    private func field(_ label: String, value: Binding<Double>) -> some View {
        HStack {
            Text(label == "From" ? "From \(unit)" : "To \(unit)")
            Spacer()
            TextField("0", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
        }
    }

    private func startTiming() {
        elapsed = 0
        startedAt = Date()
        timing = true
    }

    private func stop() {
        timing = false
        // The stopwatch's total lands in the duration field, rounded up — a
        // 4m50s sit is 5 minutes.
        minutes = "\(Int((elapsed / 60).rounded(.up)))"
    }

    private func clock(_ t: TimeInterval) -> String {
        let m = Int(t) / 60, s = Int(t) % 60
        return String(format: "%d:%02d", m, s)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        // Everything travels as percent — the bridge turns it back into pages
        // when the book has a count, exactly what the reader's own sync sends.
        let startPct = paged ? (start / Double(row.totalPages!)) * 100 : start
        let endPct = paged ? (end / Double(row.totalPages!)) * 100 : end
        await BookMaster.shared.syncSession(
            ref: BMBookRef(
                title: row.title, author: row.author ?? "",
                isbn: row.isbn, openLibraryId: row.openLibraryId,
                userBookId: row.userBookId),
            percentStart: startPct, percentEnd: endPct,
            minutes: Double(minutes) ?? 0, at: Date())
        onDone()
        dismiss()
    }
}
