import Foundation
import Observation

/// Watches one folder from Files (iCloud Drive, a Dropbox folder…) and imports
/// whatever new books land in it, so dropping a file there is the whole job.
///
/// The folder is kept as a security-scoped bookmark; each scan opens it,
/// imports files it hasn't seen (by path, size and modification date), and
/// closes it. Files still downloading from iCloud show up as hidden
/// `.name.icloud` placeholders and are picked up on a later scan.
@Observable
@MainActor
final class FolderWatcher {
    static let shared = FolderWatcher()

    private(set) var folderName: String?
    private(set) var scanning = false

    private let bookmarkKey = "watchedFolderBookmark"
    private let seenKey = "watchedFolderSeen"
    private let seenMax = 5000
    private let supported = Set(["epub", "pdf", "cbz"]).union(Book.audioExtensions)

    private init() {
        folderName = resolve()?.lastPathComponent
    }

    var isWatching: Bool { folderName != nil }

    /// Start watching a folder the reader picked. Everything already in it
    /// counts as new — they chose it to have it imported.
    func watch(_ url: URL, library: LibraryStore) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        else {
            library.lastError = "That folder can’t be watched."
            return
        }
        UserDefaults.standard.set(data, forKey: bookmarkKey)
        UserDefaults.standard.removeObject(forKey: seenKey)
        folderName = url.lastPathComponent
        await scan(library: library)
    }

    func stop() {
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        UserDefaults.standard.removeObject(forKey: seenKey)
        folderName = nil
    }

    /// Import anything new in the folder. Safe to call often.
    func scan(library: LibraryStore) async {
        guard !scanning, let folder = resolve() else { return }
        scanning = true
        defer { scanning = false }
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }

        var seen = Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? [])
        var fresh: [(url: URL, key: String)] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let walker = FileManager.default.enumerator(
            at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]
        ) else { return }
        for case let url as URL in walker {
            guard supported.contains(url.pathExtension.lowercased()),
                  let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true
            else { continue }
            let stamp = values.contentModificationDate?.timeIntervalSince1970 ?? 0
            let key = "\(url.path)|\(values.fileSize ?? 0)|\(Int(stamp))"
            if !seen.contains(key) { fresh.append((url, key)) }
        }
        guard !fresh.isEmpty else { return }

        await library.importFiles(fresh.map { $0.url })
        // marked seen even when an import failed, so one bad file isn't retried forever
        for item in fresh { seen.insert(item.key) }
        UserDefaults.standard.set(Array(seen.suffix(seenMax)), forKey: seenKey)
    }

    private func resolve() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        else { return nil }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: bookmarkKey)
        }
        return url
    }
}
