import Foundation

func runBackupChecks() {
    section("Portable backup routing and file integrity")
    let web: [String: Any] = ["fileName": "Dune.epub", "fileKey": "file:123", "fileKeys": ["file:123"]]
    check("web importer records with filenames use web file keys", !BackupFiles.isNative(platform: nil, record: web))
    check("native exports with web-compatible keys stay native", BackupFiles.isNative(platform: "ios", record: web))
    check("legacy filename-only native backups still work", BackupFiles.isNative(platform: nil, record: ["fileName": "x.epub"]))
    check("matching ZIP checksum accepted", (try? BackupFiles.verify(checksum: 123, expected: 123)) != nil)
    check("damaged ZIP payload refused", (try? BackupFiles.verify(checksum: 124, expected: 123)) == nil)

    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? fm.removeItem(at: root) }
    do {
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source.mp3")
        let missing = root.appendingPathComponent("missing.mp3")
        let first = root.appendingPathComponent("first.mp3")
        let second = root.appendingPathComponent("second.mp3")
        try Data("track".utf8).write(to: source)
        do {
            try BackupFiles.install([(source, first), (missing, second)])
            check("missing later track throws", false)
        } catch {
            check("missing later track leaves no orphan", !fm.fileExists(atPath: first.path))
        }
        try Data("existing".utf8).write(to: second)
        do {
            try BackupFiles.install([(source, first), (source, second)])
            check("destination conflict throws", false)
        } catch {
            check("later copy failure rolls back earlier files", !fm.fileExists(atPath: first.path))
            check("rollback preserves pre-existing files", try Data(contentsOf: second) == Data("existing".utf8))
        }
        try fm.removeItem(at: second)
        try BackupFiles.install([(source, first), (source, second)])
        check("complete retry restores every track", fm.fileExists(atPath: first.path) && fm.fileExists(atPath: second.path))
    } catch { check("backup file checks complete", false, error.localizedDescription) }
}
