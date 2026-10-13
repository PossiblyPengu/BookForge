import Foundation

enum BackupFiles {
    enum Failure: Error { case missingPayload, damagedPayload }

    static func isNative(platform: String?, record: [String: Any]) -> Bool {
        if let platform { return platform == "ios" }
        return record["fileKey"] == nil && record["fileKeys"] == nil && record["fileName"] != nil
    }

    static func verify(checksum: UInt32, expected: UInt32) throws {
        guard checksum == expected else { throw Failure.damagedPayload }
    }

    static func install(_ files: [(source: URL, destination: URL)], using fm: FileManager = .default) throws {
        guard files.allSatisfy({ fm.fileExists(atPath: $0.source.path) }) else {
            throw Failure.missingPayload
        }
        var installed: [URL] = []
        do {
            for file in files {
                if !fm.fileExists(atPath: file.destination.path) { installed.append(file.destination) }
                try fm.copyItem(at: file.source, to: file.destination)
            }
        } catch {
            for url in installed { try? fm.removeItem(at: url) }
            throw error
        }
    }
}
