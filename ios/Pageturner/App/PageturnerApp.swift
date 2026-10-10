import SwiftUI

@main
struct PageturnerApp: App {
    @StateObject private var library = LibraryStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(library)
                // "Open in Pageturner" from Files, Mail, the share sheet…
                // and `pageturner://link?code=…`, BookMaster's pair flow coming home.
                .onOpenURL { url in
                    if url.scheme == BookMasterLinker.scheme {
                        // The in-app sheet normally consumes this. A code that
                        // arrives here is only good if this app started a link —
                        // otherwise a web page could link the device to its own account.
                        guard BookMasterLinker.shared.pending,
                              let code = BookMasterLinker.code(from: url)
                        else { return }
                        Task { try? await BookMaster.shared.redeem(code: code) }
                    } else {
                        Task { await library.importFiles([url]) }
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background {
                        Task { await BookMaster.shared.beat(leaving: true) }
                    }
                }
                // runs while the app is in front: say hello first (the slow work
                // below must not delay it), then every 45s — BookMaster counts
                // you as here for two minutes after a beat
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    await BookMaster.shared.beat()
                    await BookMaster.shared.flush()
                    await FolderWatcher.shared.scan(library: library)
                    await BookMaster.shared.pullShelf(into: library)
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(45))
                        guard !Task.isCancelled else { return }
                        await BookMaster.shared.beat()
                    }
                }
        }
    }
}
