import SwiftUI
import UniformTypeIdentifiers

/// Everything that used to crowd the library's menu: the BookMaster link,
/// the watched folder, and backup.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var library: LibraryStore
    @State private var shareItem: ShareItem?
    @State private var message: String?
    @State private var showFolderPicker = false
    @State private var showBackupImporter = false
    @State private var confirmResetStats = false
    @AppStorage(SpotlightIndexer.enabledKey) private var spotlight = true
    private let watcher = FolderWatcher.shared

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }

    var body: some View {
        NavigationStack {
            switches(form)
        }
    }

    /// The Spotlight switch and the reset confirmation, kept apart from the form's
    /// own modifiers so no single chain is too long for the compiler.
    private func switches<V: View>(_ content: V) -> some View {
        content
            .onChange(of: spotlight) { _, on in
                SpotlightIndexer.shared.setEnabled(on, library: library)
            }
            .confirmationDialog(
                "Reset reading stats?", isPresented: $confirmResetStats, titleVisibility: .visible
            ) {
                Button("Reset Stats", role: .destructive) { ReadingLog.shared.clear() }
            } message: {
                Text("This clears the time, streaks and charts kept on this phone. BookMaster’s own numbers aren’t touched.")
            }
    }

    private var form: some View {
        Form {
            BookMasterSection()

            Section {
                if watcher.isWatching {
                    LabeledContent("Watching", value: watcher.folderName ?? "")
                    Button("Stop Watching", role: .destructive) { watcher.stop() }
                } else {
                    Button { showFolderPicker = true } label: {
                        Label("Watch a Folder…", systemImage: "folder.badge.plus")
                    }
                }
            } header: {
                Text("Auto-import")
            } footer: {
                Text("New EPUB, PDF, CBZ and audio files that appear in the folder are added to your library whenever Pageturner opens.")
            }

            Section {
                Toggle("Show books in Spotlight", isOn: $spotlight)
                Button("Reset Reading Stats…", role: .destructive) { confirmResetStats = true }
            } header: {
                Text("Search & stats")
            } footer: {
                Text("Spotlight lists your titles, authors and covers using iOS’s own on-device index. Reading stats are kept on this phone; resetting them doesn’t touch BookMaster.")
            }

            Section("Backup") {
                Button { exportBackup() } label: {
                    Label("Export Library Backup", systemImage: "square.and.arrow.up")
                }
                Button { showBackupImporter = true } label: {
                    Label("Restore Backup…", systemImage: "square.and.arrow.down")
                }
            }

            Section("About") {
                LabeledContent("Version", value: version)
                Text("Reading is built on the Readium toolkit.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .onAppear { BookMaster.shared.place = "settings" }
        .onDisappear { BookMaster.shared.place = "library" }
        .fileImporter(isPresented: $showFolderPicker, allowedContentTypes: [.folder]) { result in
            if case let .success(url) = result {
                Task { await watcher.watch(url, library: library) }
            }
        }
        .fileImporter(isPresented: $showBackupImporter, allowedContentTypes: [.zip]) { result in
            if case let .success(url) = result { restoreBackup(url) }
        }
        .sheet(item: $shareItem) { ShareSheet(items: [$0.url]) }
        .alert("Backup", isPresented: Binding(
            get: { message != nil },
            set: { if !$0 { message = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }

    private func exportBackup() {
        message = nil
        Task {
            do {
                let url = try await BackupStore(library: library).exportBackup()
                shareItem = ShareItem(url: url)
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func restoreBackup(_ url: URL) {
        message = nil
        Task {
            do {
                let r = try await BackupStore(library: library).importBackup(url)
                message = "Restored \(r.restored) book\(r.restored == 1 ? "" : "s")"
                    + (r.skipped > 0 ? " · skipped \(r.skipped)" : "")
            } catch {
                message = error.localizedDescription
            }
        }
    }
}
