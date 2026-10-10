import AuthenticationServices
import SwiftUI

/// Link (or unlink) this device's BookMaster account.
struct BookMasterSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var library: LibraryStore
    @State private var working = false
    @State private var error: String?
    private let bookMaster = BookMaster.shared

    var body: some View {
        NavigationStack {
            Form {
                if let user = bookMaster.user {
                    Section {
                        Label(user.displayName ?? user.username, systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                        Text("Your reading progress and finished sessions go to BookMaster as you read and listen.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Section {
                        Button("Unlink BookMaster", role: .destructive) {
                            bookMaster.unlink()
                            library.clearBookMasterFields()
                        }
                    }
                } else {
                    Section {
                        Text("Link your BookMaster account to log reading sessions, keep progress in sync and see what the other reader is on. Nothing leaves this device until you link.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await link() }
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
            .navigationTitle("BookMaster")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func link() async {
        working = true
        error = nil
        defer { working = false }
        do {
            try await BookMasterLinker.shared.link()
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            // the reader closed the sheet — not an error
        } catch {
            self.error = error.localizedDescription
        }
    }
}
