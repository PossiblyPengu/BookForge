import SwiftUI
import UniformTypeIdentifiers

/// A Goodreads export into BookMaster: the file is parsed on the phone (it
/// never leaves the device), the bridge says how much is new, then the rows
/// shelve through the same find-or-create the web import uses.
struct BMImportSheet: View {
    var onDone: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    @State private var report: GoodreadsCSV.Report?
    @State private var preview: BMImportReply?
    @State private var imported: BMImportReply?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let imported {
                    doneSection(imported)
                } else if let report {
                    reviewSection(report)
                } else {
                    pickSection
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Import from Goodreads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(imported == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.commaSeparatedText, .plainText]) { result in
                switch result {
                case .success(let url): read(url)
                case .failure(let failure): error = failure.localizedDescription
                }
            }
        }
    }

    private var pickSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("Goodreads → Your Library → Export Library gives you a CSV. Pick it here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button { picking = true } label: {
                    Label("Choose the export", systemImage: "doc.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.ptAccent)
            }
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func reviewSection(_ report: GoodreadsCSV.Report) -> some View {
        Section("The file") {
            LabeledContent("Rows read", value: "\(report.books.count)")
            if !report.skipped.isEmpty {
                LabeledContent("Skipped", value: "\(report.skipped.count)")
                ForEach(report.skipped.prefix(3), id: \.row) { skip in
                    Text("Row \(skip.row): \(skip.reason)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if report.skipped.count > 3 {
                    Text("…and \(report.skipped.count - 3) more")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if let preview {
            Section("On BookMaster") {
                LabeledContent("Already on your shelf", value: "\(preview.alreadyHave ?? 0)")
                LabeledContent("Would be added", value: "\(preview.willAdd ?? 0)")
            }
        }
        Section {
            Button { Task { await run(report) } } label: {
                if busy {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Import \(report.books.count) books", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.ptAccent)
            .disabled(busy || report.books.isEmpty)
        }
    }

    private func doneSection(_ reply: BMImportReply) -> some View {
        Section("Imported") {
            LabeledContent("Added to your shelf", value: "\(reply.imported ?? 0)")
            if let d = reply.duplicates, d > 0 {
                LabeledContent("Merged duplicates", value: "\(d)")
            }
            if let have = reply.alreadyHave, have > 0 {
                LabeledContent("Already there", value: "\(have)")
            }
        }
    }

    private func read(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            let parsed = GoodreadsCSV.parse(text)
            guard !parsed.books.isEmpty else {
                error = parsed.skipped.first?.reason ?? "No books found in that file."
                return
            }
            report = parsed
            error = nil
            Task { await preview(parsed.books) }
        } catch {
            self.error = "Couldn’t read the file: \(error.localizedDescription)"
        }
    }

    private func preview(_ rows: [BMImportRow]) async {
        do {
            preview = try await BookMaster.shared.importRows(rows, preview: true)
        } catch {
            preview = nil  // a preview failure must not block the real import
        }
    }

    private func run(_ report: GoodreadsCSV.Report) async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await BookMaster.shared.importRows(report.books)
            imported = reply
            onDone("Imported \(reply.imported ?? 0) books")
        } catch {
            self.error = error.localizedDescription
        }
    }
}
