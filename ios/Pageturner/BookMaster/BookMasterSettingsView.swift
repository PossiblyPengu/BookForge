import SwiftUI

/// Link (or unlink) this device's BookMaster account — sections for the settings form.
struct BookMasterSection: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var working = false
    @State private var error: String?
    @State private var showLink = false
    private let bookMaster = BookMaster.shared
    private let notifier = Notifier.shared

    var body: some View {
        Group {
            if let user = bookMaster.user {
                Section("BookMaster") {
                    Label(user.displayName ?? user.username, systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    Toggle("Send progress and sessions", isOn: Binding(
                        get: { bookMaster.syncEnabled },
                        set: { bookMaster.syncEnabled = $0 }
                    ))
                    Text(bookMaster.syncEnabled
                        ? "Your reading progress and finished sessions go to BookMaster as you read and listen."
                        : "Paused. Nothing is sent while you read; comments, suggestions and quotes still work.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Toggle("Notify me about suggestions", isOn: Binding(
                        get: { notifier.enabled },
                        set: { on in Task { await notifier.setEnabled(on) } }
                    ))
                    if notifier.blockedBySystem {
                        Text("Notifications are turned off for Pageturner in iOS Settings.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Button("Open iOS Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                    } else {
                        Text("A suggestion from the other reader shows up as a notification. iOS decides when Pageturner may check in the background, so it can take a while — and Background App Refresh has to be on.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button("Unlink BookMaster", role: .destructive) {
                        bookMaster.unlink()
                        library.clearBookMasterFields()
                        notifier.reset()
                    }
                }
            } else {
                Section("BookMaster") {
                    Text("Link your BookMaster account to log reading sessions, keep progress in sync and see what the other reader is on. Nothing leaves this device until you link.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button {
                        showLink = true
                    } label: {
                        if working { ProgressView() } else { Text("Link BookMaster") }
                    }
                    .disabled(working)
                }
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .task { await notifier.refreshAuthorization() }
        .sheet(isPresented: $showLink) {
            BookMasterLinkSheet(
                onCode: { code in
                    showLink = false
                    Task { await finishLink(code) }
                },
                onCancel: { showLink = false })
        }
    }

    /// The sheet gave back a code: spend it, then let the app know who it is now.
    private func finishLink(_ code: String) async {
        working = true
        error = nil
        defer { working = false }
        if let message = await BookMasterLinker.shared.finish(code: code) {
            error = "Couldn’t link BookMaster: \(message)"
        } else {
            await bookMaster.pullShelf(into: library)
            await bookMaster.beat()
        }
    }
}
