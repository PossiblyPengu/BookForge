import SwiftUI

@main
struct PageturnerApp: App {
    @StateObject private var library = LibraryStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(library)
                // "Open in Pageturner" from Files, Mail, the share sheet…
                // and `pageturner://link?code=…`, BookMaster's pair flow coming home.
                .onOpenURL { url in
                    if url.scheme == BookMasterLinker.scheme {
                        // normally the in-app sheet consumes this; a code that
                        // arrives here instead (sheet dismissed) is still good
                        if let code = BookMasterLinker.code(from: url) {
                            Task { try? await BookMaster.shared.redeem(code: code) }
                        }
                    } else {
                        Task { await library.importFiles([url]) }
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            Task {
                switch phase {
                case .active:
                    await FolderWatcher.shared.scan(library: library)
                    await BookMaster.shared.flush()
                    await BookMaster.shared.pullShelf(into: library)
                    await BookMaster.shared.beat(place: "library")
                case .background:
                    await BookMaster.shared.beat(leaving: true)
                default:
                    break
                }
            }
        }
    }
}
