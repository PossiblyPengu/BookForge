import SwiftUI

/// The other reader: where they are, what they have finished, their year so
/// far — and the suggestions in flight both ways. The Together page of
/// BookMaster, whole.
struct BookMasterTogetherView: View {
    @State private var together: BMTogether?
    @State private var partnerShelf: BMPartnerShelf?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        List {
            if let partner = together?.partner {
                nowSection(partner)
            }
            if let shelf = partnerShelf {
                if let stats = shelf.stats { comparisonSection(shelf) }
                shelfSection(shelf)
            }
            if let together {
                if !together.nudges.isEmpty { waitingSection(together.nudges) }
                if !together.sent.isEmpty { sentSection(together.sent) }
                if !together.notices.isEmpty {
                    Section("From the other apps") {
                        ForEach(together.notices) { notice in Text(notice.text) }
                    }
                }
            }
            if loading, together == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let error { Section { Text(error).foregroundStyle(.secondary) } }
            if together?.partner == nil, !loading {
                Section {
                    Text("No one else on this BookMaster yet.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Together")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    /// Where they are right now.
    private func nowSection(_ partner: BMPartner) -> some View {
        Section {
            HStack {
                Circle()
                    .fill(partner.online ? Color.green : Color.secondary.opacity(0.4))
                    .frame(width: 10, height: 10)
                Text(partner.name).font(.headline)
                Spacer()
                Text(partner.online ? "Here now" : "Away")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reading = partner.reading {
                VStack(alignment: .leading, spacing: 2) {
                    Text(reading.title)
                    HStack {
                        if let author = reading.author { Text(author) }
                        if let percent = reading.percent { Text("· \(Int(percent.rounded()))%") }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            } else {
                Text("Not reading anything right now").foregroundStyle(.secondary)
            }
        }
    }

    /// How their year is going against the same numbers.
    private func comparisonSection(_ shelf: BMPartnerShelf) -> some View {
        Section("Their year") {
            if let books = shelf.booksThisYear {
                LabeledContent("Books finished", value: "\(books)")
            }
            if let pages = shelf.pagesThisYear {
                LabeledContent("Pages read", value: "\(Int(pages))")
            }
            if let streak = shelf.stats.flatMap(\.currentStreak) {
                LabeledContent("Current streak", value: "\(Int(streak)) days")
            }
            if let minutes = shelf.stats.flatMap(\.minutesRead) {
                LabeledContent("Time read", value: minutes >= 60
                    ? "\(Int(minutes) / 60)h \(Int(minutes) % 60)m"
                    : "\(Int(minutes))m")
            }
        }
    }

    /// Their shelf — what they read and how they rated it, never their review.
    private func shelfSection(_ shelf: BMPartnerShelf) -> some View {
        Section("\(shelf.partner?.name ?? "Their") shelf") {
            ForEach(shelf.books) { book in
                HStack(spacing: 12) {
                    AsyncImage(url: bmCoverURL(isbn: book.isbn, openLibraryId: book.openLibraryId)) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            Color.secondary.opacity(0.15).overlay(
                                Image(systemName: book.format == "audio" ? "headphones" : "book.closed")
                                    .foregroundStyle(.secondary))
                        }
                    }
                    .frame(width: 40, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

                    VStack(alignment: .leading, spacing: 3) {
                        Text(book.title ?? "Untitled").font(.body.weight(.medium)).lineLimit(2)
                        HStack(spacing: 6) {
                            if let status = book.status { Text(BMShelf.label(forStatus: status)) }
                            if let percent = book.percent, book.status == "reading" {
                                Text("· \(Int(percent.rounded()))%")
                            }
                            if let rating = book.rating, rating > 0 {
                                Text(String(repeating: "★", count: min(rating, 5)))
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// Suggestions for you, with the answer buttons.
    private func waitingSection(_ nudges: [BMNudge]) -> some View {
        Section("Suggested for you") {
            ForEach(nudges) { nudge in
                VStack(alignment: .leading, spacing: 6) {
                    Text(nudge.title).font(.headline)
                    Text("From \(nudge.fromName)\(nudge.author.map { " · \($0)" } ?? "")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty { Text("“\(note)”").font(.callout) }
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

    /// Suggestions of yours still out with them.
    private func sentSection(_ sent: [BMSentNudge]) -> some View {
        Section("Waiting on them") {
            ForEach(sent) { nudge in
                VStack(alignment: .leading, spacing: 4) {
                    Text(nudge.title).font(.headline)
                    Text("To \(nudge.toName) · \(nudge.status)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let note = nudge.note, !note.isEmpty { Text("“\(note)”").font(.callout) }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func load() async {
        guard BookMaster.shared.isLinked else {
            together = nil
            partnerShelf = nil
            loading = false
            return
        }
        async let t = try? await BookMaster.shared.fetchTogether()
        async let p = try? await BookMaster.shared.fetchPartnerShelf()
        let (together, partnerShelf) = await (t, p)
        guard !Task.isCancelled else { return }
        if let together {
            self.together = together
            Notifier.shared.noteSeen(together)
        }
        if let partnerShelf { self.partnerShelf = partnerShelf }
        error = (together == nil && self.together == nil)
            ? "BookMaster can’t be reached right now." : nil
        loading = false
    }

    private func answer(_ nudge: BMNudge, accept: Bool) async {
        do {
            try await BookMaster.shared.answerNudge(id: nudge.id, accept: accept)
            together?.nudges.removeAll { $0.id == nudge.id }
            if let together { Notifier.shared.noteSeen(together) }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
