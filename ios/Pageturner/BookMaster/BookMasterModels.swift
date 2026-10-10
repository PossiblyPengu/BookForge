import Foundation

/// The reader this device is linked as. BookMaster's bridge knows people by
/// username; there is no token — the secret lives in the Pages Function.
struct BMUser: Codable, Equatable {
    var username: String
    var displayName: String?

    enum CodingKeys: String, CodingKey {
        case username
        case displayName = "display_name"
    }
}

/// An achievement the bridge hydrated for display.
struct BMAchievement: Decodable, Hashable {
    var id: String?
    var name: String?
    var icon: String?
}

struct BMUserBook: Decodable {
    var id: String?
}

/// What `progress` and `session` answer with.
struct BMPushReply: Decodable {
    var userBook: BMUserBook?
    var newAchievements: [BMAchievement]?
}

/// The fields every push uses to say which book it means.
struct BMBookRef: Encodable {
    var title: String
    var author: String
    var isbn: String?
    var openLibraryId: String?
    /// The shelf row BookMaster gave back last time; pinning beats guessing.
    var userBookId: String?

    enum CodingKeys: String, CodingKey {
        case title, author, isbn
        case openLibraryId = "open_library_id"
        case userBookId = "user_book_id"
    }
}

struct BMProgressPush: Encodable {
    var username: String
    var book: BMBookRef
    var percent: Double
    var format: String
    var status: String?
    var rating: Int?
    var coverB64: String?
    var coverMime: String?

    enum CodingKeys: String, CodingKey {
        case username, percent, format, status, rating
        case coverB64 = "cover_b64"
        case coverMime = "cover_mime"
    }

    // The book fields sit at the top level of the JSON, not under "book".
    func encode(to encoder: Encoder) throws {
        try book.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(username, forKey: .username)
        try c.encode(percent, forKey: .percent)
        try c.encode(format, forKey: .format)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(rating, forKey: .rating)
        try c.encodeIfPresent(coverB64, forKey: .coverB64)
        try c.encodeIfPresent(coverMime, forKey: .coverMime)
    }
}

struct BMSessionPush: Encodable {
    var username: String
    var book: BMBookRef
    var percentStart: Double
    var percentEnd: Double
    var durationMinutes: Int?
    /// When the stretch ended, in milliseconds since 1970 — what the bridge requires.
    var at: Double

    enum CodingKeys: String, CodingKey {
        case username, at
        case percentStart = "percent_start"
        case percentEnd = "percent_end"
        case durationMinutes = "duration_minutes"
    }

    func encode(to encoder: Encoder) throws {
        try book.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(username, forKey: .username)
        try c.encode(percentStart, forKey: .percentStart)
        try c.encode(percentEnd, forKey: .percentEnd)
        try c.encodeIfPresent(durationMinutes, forKey: .durationMinutes)
        try c.encode(at, forKey: .at)
    }
}

struct BMQuotePush: Encodable {
    var username: String
    var book: BMBookRef
    var content: String
    var percent: Double?

    enum CodingKeys: String, CodingKey { case username, content, percent }

    func encode(to encoder: Encoder) throws {
        try book.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(username, forKey: .username)
        try c.encode(content, forKey: .content)
        try c.encodeIfPresent(percent, forKey: .percent)
    }
}

enum BMError: LocalizedError {
    case notLinked
    case server(Int, String?)

    var errorDescription: String? {
        switch self {
        case .notLinked: return "Not linked to BookMaster"
        case let .server(code, message): return message ?? "BookMaster answered \(code)"
        }
    }
}

/// "Herbert, Frank" and "Frank Herbert (Author)" both go up as "Frank Herbert",
/// so a row created by a push doesn't read backwards forever.
func sendableAuthor(_ raw: String) -> String {
    var clean = raw
    while let open = clean.firstIndex(of: "("), let close = clean[open...].firstIndex(of: ")") {
        clean.replaceSubrange(open...close, with: " ")
    }
    clean = clean.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    let parts = clean.split(separator: ",", omittingEmptySubsequences: false).map {
        $0.trimmingCharacters(in: .whitespaces)
    }
    let ambiguous = clean.contains(";") || clean.contains("&")
    if parts.count == 2, !ambiguous, !parts[0].isEmpty, !parts[1].isEmpty {
        return "\(parts[1]) \(parts[0])"
    }
    return clean
}

// MARK: - Together

struct BMReading: Decodable, Hashable {
    var title: String
    var author: String?
    var format: String?
    var percent: Double?
}

struct BMPartner: Decodable {
    var name: String
    var online: Bool
    var reading: BMReading?
}

struct BMNudge: Decodable, Identifiable, Hashable {
    var id: String
    var note: String?
    var fromName: String
    var title: String
    var author: String?
}

/// A line another suite app wants this one to show.
struct BMNotice: Decodable, Identifiable, Hashable {
    var id: String
    var app: String
    var text: String
}

struct BMTogether: Decodable {
    var partner: BMPartner?
    var nudges: [BMNudge]
    var notices: [BMNotice]
}

// MARK: - Comments

struct BMComment: Decodable, Identifiable, Hashable {
    var id: String
    /// Nil while sealed: a note left further on than the reader has got.
    var content: String?
    var displayName: String
    var userId: String
    var atPercent: Double?
    var ahead: Bool

    enum CodingKeys: String, CodingKey {
        case id, content, ahead
        case displayName = "display_name"
        case userId = "user_id"
        case atPercent = "at_percent"
    }
}

struct BMThread: Decodable {
    var comments: [BMComment]
    var you: String?
}
