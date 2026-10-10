import Foundation
import Observation

/// BookMaster sync, the Swift side of `docs/js/bookmaster.js`.
///
/// Every call goes through the Pages Function at `pageturner.pages.dev`, the
/// only place the bridge secret lives. Pushes the network can't take are parked
/// in a small on-disk queue and replayed oldest-first: progress is a position,
/// so a newer one replaces a queued one for the same book, while every session
/// and quote is its own event and always rides the queue.
@Observable
@MainActor
final class BookMaster {
    static let shared = BookMaster()

    static let bridge = URL(string: "https://pageturner.pages.dev/api/bookmaster")!
    static let queueMax = 50

    private(set) var user: BMUser?
    /// One-line message for the UI to show once (achievements, a dead link).
    var notice: String?

    var isLinked: Bool { user != nil }

    private struct QueueEntry: Codable {
        var kind: String          // "progress" | "session" | "quote"
        var title: String         // progress de-dupe key
        var body: Data
    }

    private let defaults = UserDefaults.standard
    private let userKey = "bm-user"
    private var queue: [QueueEntry] = []
    private var flushing = false
    private var warnedBroken = false
    private var lastPush: [String: (at: Date, percent: Double)] = [:]

    private var queueURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("bm-queue.json")
    }

    private init() {
        if let data = defaults.data(forKey: userKey) {
            user = try? JSONDecoder().decode(BMUser.self, from: data)
        }
        if let data = try? Data(contentsOf: queueURL) {
            queue = (try? JSONDecoder().decode([QueueEntry].self, from: data)) ?? []
        }
    }

    // MARK: Linking

    /// Spend a one-time code BookMaster minted for this device.
    func redeem(code: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        let (data, status) = try await post("link", body: body)
        guard (200..<300).contains(status) else {
            throw BMError.server(status, Self.errorMessage(data))
        }
        let linked = try JSONDecoder().decode(BMUser.self, from: data)
        setUser(linked)
        warnedBroken = false
        await flush()
    }

    func unlink() {
        setUser(nil)
    }

    private func setUser(_ value: BMUser?) {
        user = value
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: userKey)
        } else {
            defaults.removeObject(forKey: userKey)
        }
    }

    // MARK: Pushes

    /// Reading position, throttled to once per 30s per book unless forced
    /// (book closed, playback paused). Fire-and-forget: never blocks reading.
    func syncProgress(
        bookKey: String, ref book: BMBookRef, percent: Double,
        isAudio: Bool, rating: Int? = nil, force: Bool = false,
        pinned: @escaping (String) -> Void
    ) async {
        guard let user else { return }
        let pct = (percent * 1000).rounded() / 10
        if !force {
            if let last = lastPush[bookKey] {
                if last.percent == pct { return }
                if Date().timeIntervalSince(last.at) < 30 { return }
            }
        }
        lastPush[bookKey] = (Date(), pct)
        let payload = BMProgressPush(
            username: user.username, book: book, percent: pct,
            format: isAudio ? "audio" : "ebook",
            status: percent >= 0.995 ? "read" : nil, rating: rating)
        guard let body = try? JSONEncoder().encode(payload) else { return }
        guard let reply = await send(kind: "progress", title: book.title, body: body) else { return }
        if let id = reply.userBook?.id { pinned(id) }
    }

    /// A finished stretch of reading; BookMaster logs it as a real session.
    func syncSession(
        ref: BMBookRef, percentStart: Double, percentEnd: Double,
        minutes: Double, at: Date
    ) async {
        guard let user else { return }
        let payload = BMSessionPush(
            username: user.username, book: ref,
            percentStart: (percentStart * 1000).rounded() / 10,
            percentEnd: (percentEnd * 1000).rounded() / 10,
            durationMinutes: minutes >= 0.5 ? Int(minutes.rounded()) : nil,
            at: (at.timeIntervalSince1970 * 1000).rounded())
        guard let body = try? JSONEncoder().encode(payload) else { return }
        _ = await send(kind: "session", title: ref.title, body: body)
    }

    /// A line worth keeping, from the reader's selection menu.
    @discardableResult
    func postQuote(ref: BMBookRef, content: String, percent: Double?) async -> Bool {
        guard let user, !content.isEmpty else { return false }
        let payload = BMQuotePush(
            username: user.username, book: ref, content: content,
            percent: percent.map { $0 * 100 })
        guard let body = try? JSONEncoder().encode(payload) else { return false }
        await flush()
        return await sendRaw(kind: "quote", title: ref.title, body: body)
    }

    /// "I'm here" — never queued: a replayed beat lies about when you were there.
    func beat(place: String? = nil, leaving: Bool = false) async {
        guard let user else { return }
        var json: [String: Any] = ["username": user.username]
        if let place { json["place"] = place }
        if leaving { json["leaving"] = true }
        guard let body = try? JSONSerialization.data(withJSONObject: json) else { return }
        _ = try? await post("presence", body: body)
    }

    // MARK: Reads

    /// The other reader, the suggestions waiting on you, and notices from the
    /// rest of the suite. A solo instance answers with no partner.
    func fetchTogether() async throws -> BMTogether {
        guard let user else { throw BMError.notLinked }
        let (data, status) = try await get("together", query: ["username": user.username])
        guard (200..<300).contains(status) else {
            handleRefusal(status: status, data: data)
            throw BMError.server(status, Self.errorMessage(data))
        }
        return try JSONDecoder().decode(BMTogether.self, from: data)
    }

    /// Accept a suggestion onto the want-to-read shelf, or dismiss it.
    func answerNudge(id: String, accept: Bool) async throws {
        guard let user else { throw BMError.notLinked }
        let body = try JSONSerialization.data(withJSONObject: [
            "username": user.username, "id": id, "action": accept ? "accept" : "dismiss",
        ])
        let (data, status) = try await post("nudge-answer", body: body)
        guard (200..<300).contains(status) else {
            throw BMError.server(status, Self.errorMessage(data))
        }
    }

    // MARK: Sending

    /// Send a push, parking it when the network can't take it. Returns the
    /// reply when the bridge accepted it, nil when parked or refused.
    private func send(kind: String, title: String, body: Data) async -> BMPushReply? {
        await flush()
        do {
            let (data, status) = try await post(kind, body: body)
            if Self.retriable(status) {
                enqueue(QueueEntry(kind: kind, title: title, body: body))
                return nil
            }
            guard (200..<300).contains(status) else {
                handleRefusal(status: status, data: data)
                return nil
            }
            let reply = try? JSONDecoder().decode(BMPushReply.self, from: data)
            announce(reply?.newAchievements)
            return reply
        } catch {
            enqueue(QueueEntry(kind: kind, title: title, body: body))
            return nil
        }
    }

    /// `send` for pushes whose only answer that matters is success.
    private func sendRaw(kind: String, title: String, body: Data) async -> Bool {
        do {
            let (data, status) = try await post(kind, body: body)
            if Self.retriable(status) {
                enqueue(QueueEntry(kind: kind, title: title, body: body))
                return true   // parked for later — report success
            }
            if !(200..<300).contains(status) {
                handleRefusal(status: status, data: data)
                return false
            }
            return true
        } catch {
            enqueue(QueueEntry(kind: kind, title: title, body: body))
            return true
        }
    }

    /// Drain the queue oldest-first, stopping at the first push the network
    /// still won't take — order is the point. A 4xx can never succeed, so it is
    /// dropped rather than left to block the line behind it.
    func flush() async {
        if flushing { return }
        flushing = true
        defer { flushing = false }
        while let head = queue.first {
            let result: (Data, Int)
            do { result = try await post(head.kind, body: head.body) } catch { return }
            if Self.retriable(result.1) { return }
            queue.removeFirst()
            saveQueue()
            if !(200..<300).contains(result.1) {
                handleRefusal(status: result.1, data: result.0)
            }
        }
    }

    private func enqueue(_ entry: QueueEntry) {
        if entry.kind == "progress" {
            queue.removeAll { $0.kind == "progress" && $0.title == entry.title }
        }
        queue.append(entry)
        while queue.count > Self.queueMax { queue.removeFirst() }
        saveQueue()
    }

    private func saveQueue() {
        if let data = try? JSONEncoder().encode(queue) {
            try? data.write(to: queueURL, options: .atomic)
        }
    }

    /// A 404 "Unknown reader" is a dead link — stop failing on every page turn.
    private func handleRefusal(status: Int, data: Data) {
        guard status == 404, Self.errorMessage(data) == "Unknown reader" else { return }
        setUser(nil)
        if !warnedBroken {
            warnedBroken = true
            notice = "BookMaster link broke — link again in Settings"
        }
    }

    private func announce(_ achievements: [BMAchievement]?) {
        guard let a = achievements?.first else { return }
        notice = "\(a.icon ?? "🏆") \(a.name ?? "Achievement earned")"
    }

    private static func retriable(_ status: Int) -> Bool { (502...504).contains(status) }

    private static func errorMessage(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }

    // MARK: Transport

    func get(_ path: String, query: [String: String]) async throws -> (Data, Int) {
        var parts = URLComponents(url: Self.bridge.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: parts.url!)
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private func post(_ path: String, body: Data) async throws -> (Data, Int) {
        var request = URLRequest(url: Self.bridge.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
