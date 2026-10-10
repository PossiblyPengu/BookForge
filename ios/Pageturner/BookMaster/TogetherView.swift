import SwiftUI

/// The other reader, what they are on, and the suggestions waiting for you.
struct TogetherView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var together: BMTogether?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if let together {
                    partnerSection(together.partner)
                    if !together.nudges.isEmpty { nudgeSection(together.nudges) }
                    if !together.notices.isEmpty { noticeSection(together.notices) }
                    if let error { Section { Text(error).foregroundStyle(.red) } }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Together")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func partnerSection(_ partner: BMPartner?) -> some View {
        Section {
            if let partner {
                HStack {
                    Circle()
                        .fill(partner.online ? Color.green : Color.secondary.opacity(0.4))
                        .frame(width: 10, height: 10)
                    Text(partner.name).font(.headline)
                    Spacer()
                    Text(partner.online ? "Here now" : "Away").font(.caption).foregroundStyle(.secondary)
                }
                if let reading = partner.reading {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reading.title)
                        HStack {
                            if let author = reading.author { Text(author) }
                            if let percent = reading.percent {
                                Text("· \(Int(percent.rounded()))%")
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Not reading anything right now").foregroundStyle(.secondary)
                }
            } else {
                Text("No one else on this BookMaster yet").foregroundStyle(.secondary)
            }
        }
    }

    private func nudgeSection(_ nudges: [BMNudge]) -> some View {
        Section("Suggested for you") {
            ForEach(nudges) { nudge in
                VStack(alignment: .leading, spacing: 6) {
                    Text(nudge.title).font(.headline)
                    Text("From \(nudge.fromName)\(nudge.author.map { " · \($0)" } ?? "")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty {
                        Text("“\(note)”").font(.callout)
                    }
                    HStack {
                        Button("Add to want to read") { Task { await answer(nudge, accept: true) } }
                            .buttonStyle(.borderedProminent)
                        Button("Dismiss") { Task { await answer(nudge, accept: false) } }
                            .buttonStyle(.bordered)
                    }
                    .controlSize(.small)
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func noticeSection(_ notices: [BMNotice]) -> some View {
        Section("From the other apps") {
            ForEach(notices) { notice in Text(notice.text) }
        }
    }

    private func load() async {
        do {
            together = try await BookMaster.shared.fetchTogether()
            error = nil
        } catch {
            if together == nil { self.error = error.localizedDescription }
        }
        loading = false
    }

    private func answer(_ nudge: BMNudge, accept: Bool) async {
        do {
            try await BookMaster.shared.answerNudge(id: nudge.id, accept: accept)
            together?.nudges.removeAll { $0.id == nudge.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
