import SwiftUI

@main
struct PageturnerApp: App {
    @StateObject private var library = LibraryStore()

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(library)
                // "Open in Pageturner" from Files, Mail, the share sheet…
                .onOpenURL { url in
                    Task { await library.importFiles([url]) }
                }
        }
    }
}
