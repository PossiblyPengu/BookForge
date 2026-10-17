import CryptoKit
import Foundation
import Observation
import UIKit

/// The installed neural voices as the speech engine needs them — readable from any thread
/// (Readium asks for a voice from a background task).
final class NeuralVoiceIndex: @unchecked Sendable {
    struct Entry {
        var voice: NeuralVoice
        var info: NeuralVoiceFormat.Installed
        var directory: URL
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func replace(with new: [Entry]) {
        lock.lock()
        entries = Dictionary(new.map { ($0.voice.id, $0) }, uniquingKeysWith: { _, last in last })
        lock.unlock()
    }

    func entry(forID id: String) -> Entry? {
        lock.lock()
        defer { lock.unlock() }
        return entries[id]
    }

    var all: [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return Array(entries.values)
    }
}

/// Asks iOS for a little longer when the app is put away mid-download.
@MainActor
private final class BackgroundGrant {
    private var id = UIBackgroundTaskIdentifier.invalid

    init() {
        id = UIApplication.shared.beginBackgroundTask(withName: "voice download") { [weak self] in
            // iOS calls this on the main thread, and wants the task ended before it returns
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// The voices that can be downloaded, which are on this iPhone, and what is being fetched.
/// Voices live in Application Support (not backed up — they can always be fetched again).
@MainActor
@Observable
final class NeuralVoiceStore {
    static let shared = NeuralVoiceStore()

    enum Phase: Equatable {
        case downloading, checking, preparing
    }

    struct Transfer: Equatable {
        var phase: Phase
        /// 0…1 while downloading.
        var fraction: Double
    }

    enum Failure: Error, LocalizedError {
        case noSpace
        case badAddress
        case server(Int)
        case damaged

        var errorDescription: String? {
            switch self {
            case .noSpace: return "There isn’t enough space on this iPhone."
            case .badAddress: return "The voice’s address couldn’t be worked out."
            case let .server(code): return "The server said \(code)."
            case .damaged: return "The download was damaged — try again."
            }
        }
    }

    let catalog: NeuralCatalog
    /// Voices that are ready to speak, by key.
    private(set) var installed: [String: NeuralVoiceFormat.Installed] = [:]
    /// Voices being fetched, by key.
    private(set) var progress: [String: Transfer] = [:]
    /// Why the last attempt for a voice failed.
    private(set) var failures: [String: String] = [:]

    let index = NeuralVoiceIndex()
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    private let root: URL
    private let downloader = NeuralDownloader()

    init() {
        if let url = Bundle.main.url(forResource: "NeuralVoices", withExtension: "json"),
           let data = try? Data(contentsOf: url), let decoded = try? NeuralCatalog.decode(data)
        {
            catalog = decoded
        } else {
            catalog = NeuralCatalog(repo: "https://huggingface.co/rhasspy/piper-voices", revision: "", voices: [])
        }
        let support = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        root = support.appendingPathComponent("Pageturner/Voices", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = root
        try? folder.setResourceValues(values)
        cleanUp()
        scan()
    }

    // MARK: What there is

    func isInstalled(_ voice: NeuralVoice) -> Bool { installed[voice.key] != nil }

    func isBusy(_ voice: NeuralVoice) -> Bool { progress[voice.key] != nil }

    /// The voices on this iPhone, in the catalogue's order.
    var installedVoices: [NeuralVoice] {
        catalog.voices.filter { installed[$0.key] != nil }
    }

    /// What the installed voices take up.
    var usedBytes: Int64 {
        installedVoices.reduce(0) { $0 + $1.onnx.size }
    }

    func directory(for voice: NeuralVoice) -> URL {
        root.appendingPathComponent(voice.key, isDirectory: true)
    }

    // MARK: Getting a voice

    /// Download `voice` and make it ready. Progress is in `progress[voice.key]`; a failure in `failures`.
    func install(_ voice: NeuralVoice) {
        guard tasks[voice.key] == nil, installed[voice.key] == nil else { return }
        failures[voice.key] = nil
        progress[voice.key] = Transfer(phase: .downloading, fraction: 0)
        tasks[voice.key] = Task { [weak self] in
            // a download that is under way when the app is put away gets a little longer
            let grant = BackgroundGrant()
            defer { grant.end() }
            do {
                guard let self else { return }
                try await self.fetch(voice)
            } catch is CancellationError {
                // asked for
            } catch let error as URLError where error.code == .cancelled {
                // asked for
            } catch {
                self?.failures[voice.key] = error.localizedDescription
                Log.error("neural", "install \(voice.key) failed: \(error.localizedDescription)")
            }
            self?.progress[voice.key] = nil
            self?.tasks[voice.key] = nil
        }
    }

    func cancel(_ voice: NeuralVoice) {
        tasks[voice.key]?.cancel()
    }

    /// Delete a voice from this iPhone.
    func remove(_ voice: NeuralVoice) {
        tasks[voice.key]?.cancel()
        try? FileManager.default.removeItem(at: directory(for: voice))
        installed[voice.key] = nil
        failures[voice.key] = nil
        refreshIndex()
    }

    // MARK: The download

    private func fetch(_ voice: NeuralVoice) async throws {
        guard let configURL = catalog.url(for: voice.config), let modelURL = catalog.url(for: voice.onnx) else { throw Failure.badAddress }
        try checkSpace(for: voice)

        // the small settings file first: a voice that can't be spoken is found out before 60 MB is spent
        let (configData, response) = try await URLSession.shared.data(from: configURL)
        if let code = (response as? HTTPURLResponse)?.statusCode, code != 200 { throw Failure.server(code) }
        guard Self.md5(of: configData) == voice.config.md5 else { throw Failure.damaged }
        _ = try NeuralVoiceFormat.parse(config: configData)

        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).part")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let key = voice.key
        try await downloader.download(modelURL, to: temporary) { [weak self] fraction in
            Task { @MainActor in self?.progress[key]?.fraction = fraction }
        }
        try Task.checkCancellation()

        progress[key] = Transfer(phase: .checking, fraction: 1)
        let expected = voice.onnx
        let intact = try await Task.detached(priority: .utility) { () throws -> Bool in
            let size = (try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size == expected.size else { return false }
            return try Self.md5(ofFileAt: temporary) == expected.md5
        }.value
        guard intact else { throw Failure.damaged }
        try Task.checkCancellation()

        progress[key] = Transfer(phase: .preparing, fraction: 1)
        let staging = root.appendingPathComponent(key + ".installing", isDirectory: true)
        let destination = directory(for: voice)
        let languageName = voice.langName
        let info = try await Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: staging)
            let info = try NeuralVoiceFormat.install(
                key: key, languageName: languageName, model: temporary, config: configData, into: staging)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: staging, to: destination)
            return info
        }.value
        installed[key] = info
        refreshIndex()
    }

    private func checkSpace(for voice: NeuralVoice) throws {
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let free = values?.volumeAvailableCapacityForImportantUsage, free < voice.onnx.size + voice.onnx.size / 3 {
            throw Failure.noSpace
        }
    }

    // MARK: On disk

    private func scan() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let fm = FileManager.default
        var found: [String: NeuralVoiceFormat.Installed] = [:]
        for voice in catalog.voices {
            let folder = directory(for: voice)
            guard fm.fileExists(atPath: folder.appendingPathComponent(NeuralVoiceFormat.modelFile).path),
                  fm.fileExists(atPath: folder.appendingPathComponent(NeuralVoiceFormat.tokensFileName).path),
                  let data = fm.contents(atPath: folder.appendingPathComponent(NeuralVoiceFormat.infoFile).path),
                  let info = try? decoder.decode(NeuralVoiceFormat.Installed.self, from: data)
            else { continue }
            found[voice.key] = info
        }
        installed = found
        refreshIndex()
    }

    /// What an interrupted install left behind.
    private func cleanUp() {
        let fm = FileManager.default
        for url in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent.hasSuffix(".installing") {
            try? fm.removeItem(at: url)
        }
        for url in (try? fm.contentsOfDirectory(at: fm.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
        where url.lastPathComponent.hasPrefix("voice-") && url.pathExtension == "part" {
            try? fm.removeItem(at: url)
        }
    }

    private func refreshIndex() {
        index.replace(with: installedVoices.compactMap { voice in
            installed[voice.key].map { .init(voice: voice, info: $0, directory: directory(for: voice)) }
        })
    }

    // MARK: Checksums

    nonisolated static func md5(of data: Data) -> String {
        Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Streamed, so a 100 MB model is never in memory.
    nonisolated static func md5(ofFileAt url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = Insecure.MD5()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Downloads one file to a place of the caller's choosing, reporting how far it has got.
final class NeuralDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private struct Job {
        var destination: URL
        var progress: @Sendable (Double) -> Void
        var continuation: CheckedContinuation<Void, Error>
        var failure: Error?
    }

    private let lock = NSLock()
    private var jobs: [Int: Job] = [:]
    /// Where an interrupted download got to, by URL, so a retry carries on instead of starting at 0%.
    private var resumeData: [URL: Data] = [:]
    private var jobURLs: [Int: URL] = [:]
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        lock.lock()
        let saved = resumeData.removeValue(forKey: url)
        lock.unlock()
        let task = saved.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                jobURLs[task.taskIdentifier] = url
                jobs[task.taskIdentifier] = Job(destination: destination, progress: progress, continuation: continuation)
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }
        lock.lock()
        let job = jobs[downloadTask.taskIdentifier]
        lock.unlock()
        job?.progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lock.lock()
        let destination = jobs[downloadTask.taskIdentifier]?.destination
        lock.unlock()
        guard let destination else { return }
        var failure: Error?
        if let code = (downloadTask.response as? HTTPURLResponse)?.statusCode, code != 200, code != 206 {
            failure = NeuralVoiceStore.Failure.server(code)
        } else {
            // the system deletes the file when this returns
            do {
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: location, to: destination)
            } catch {
                failure = error
            }
        }
        lock.lock()
        jobs[downloadTask.taskIdentifier]?.failure = failure
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let job = jobs.removeValue(forKey: task.taskIdentifier)
        let url = jobURLs.removeValue(forKey: task.taskIdentifier)
        if let url, let data = ((error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData]) as? Data {
            resumeData[url] = data
        }
        lock.unlock()
        guard let job else { return }
        if let error {
            job.continuation.resume(throwing: (error as? URLError)?.code == .cancelled ? CancellationError() : error)
        } else if let failure = job.failure {
            job.continuation.resume(throwing: failure)
        } else {
            job.continuation.resume()
        }
    }
}
