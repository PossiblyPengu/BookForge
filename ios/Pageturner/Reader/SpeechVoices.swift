import Foundation

/// Anything the voice lists can set out by language: an installed system voice, or a
/// neural voice that can be downloaded.
protocol LanguageListed: Identifiable where ID == String {
    /// What the row calls it.
    var displayName: String { get }
    /// BCP-47: "en-GB".
    var language: String { get }
    /// Higher is better, and sorts first within a locale (a Premium voice, a larger model).
    var listRank: Int { get }
    /// Words a search matches besides the name and language ("premium").
    var searchTerms: [String] { get }
}

/// An installed system voice, described without AVFoundation so that listing,
/// ordering and picking voices can be checked off-device (ios/Checks/bookmaster).
struct SpeechVoice: LanguageListed, Hashable {
    enum Quality: Int, Comparable {
        case standard, enhanced, premium

        static func < (a: Quality, b: Quality) -> Bool { a.rawValue < b.rawValue }

        /// Standard voices carry no badge.
        var badge: String? {
            switch self {
            case .standard: return nil
            case .enhanced: return "Enhanced"
            case .premium: return "Premium"
            }
        }
    }

    /// `AVSpeechSynthesisVoice.identifier`.
    var id: String
    var name: String
    /// BCP-47 as AVFoundation spells it: "en-GB".
    var language: String
    var quality: Quality = .standard
    /// Novelty voices, Personal Voice and the classic Eloquence set — they
    /// sound wrong for a book, so Readium's own list leaves them out too.
    var isNovelty = false

    /// iOS names a downloaded voice "Zoe (Premium)"; the badge says so already.
    var displayName: String {
        guard let suffix = quality.badge.map({ " (\($0))" }), name.hasSuffix(suffix) else { return name }
        return String(name.dropLast(suffix.count))
    }

    var listRank: Int { quality.rawValue }
    var searchTerms: [String] { quality.badge.map { [$0] } ?? [] }
}

/// Which voice reads a book: ordering and searching the installed list, and
/// finding the best one for a language. Pure logic.
enum SpeechVoices {
    // MARK: Language tags

    /// "en-GB", "en_GB", "EN-gb" → "en".
    static func baseLanguage(_ tag: String) -> String {
        parts(tag).first ?? ""
    }

    /// "en-GB" → "GB", "zh-Hans-CN" → "CN", "ar-001" → "001"; nil without one.
    static func region(_ tag: String) -> String? {
        parts(tag).dropFirst().first {
            ($0.count == 2 && $0.allSatisfy(\.isLetter)) || ($0.count == 3 && $0.allSatisfy(\.isNumber))
        }?.uppercased()
    }

    /// Lowercased with "-" between subtags, so "en_GB" and "en-gb" compare equal.
    static func normalized(_ tag: String) -> String {
        parts(tag).joined(separator: "-")
    }

    private static func parts(_ tag: String) -> [String] {
        tag.replacingOccurrences(of: "_", with: "-")
            .split(separator: "-")
            .map { $0.lowercased() }
    }

    // MARK: Listing

    /// What's worth offering for reading a book.
    static func readable(_ voices: [SpeechVoice]) -> [SpeechVoice] {
        voices.filter { !$0.isNovelty }
    }

    struct LanguageGroup<Voice: LanguageListed>: Identifiable {
        /// The base language code: "en".
        var id: String
        /// "English".
        var title: String
        /// The device is set up for this language.
        var isPreferred: Bool
        var voices: [Voice]
    }

    /// The voices by language: the device's own languages first (in the order
    /// the user ranked them), then the rest alphabetically. Inside a language
    /// the device's own locale comes first, then other regions together, and
    /// within those the better voices before the compact ones.
    ///
    /// `query` matches a voice's name, language tag, language name, region name or
    /// quality ("premium"), ignoring case and accents.
    static func groups<Voice: LanguageListed>(
        _ voices: [Voice],
        query: String = "",
        preferred: [String],
        languageName: (String) -> String,
        regionName: (String) -> String? = { _ in nil }
    ) -> [LanguageGroup<Voice>] {
        let needle = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        let preferredBases = preferred.map(baseLanguage)
        let preferredTags = Set(preferred.map(normalized))

        let shown = voices.filter { voice in
            guard !needle.isEmpty else { return true }
            let base = baseLanguage(voice.language)
            let haystack = [
                voice.displayName, voice.language, languageName(base),
                region(voice.language).flatMap(regionName) ?? "",
            ] + voice.searchTerms
            return haystack.contains { fold($0).contains(needle) }
        }

        func order(_ a: Voice, _ b: Voice) -> Bool {
            let (ma, mb) = (preferredTags.contains(normalized(a.language)), preferredTags.contains(normalized(b.language)))
            if ma != mb { return ma }
            // other regions stay together rather than interleaving by quality
            if !ma, normalized(a.language) != normalized(b.language) {
                return normalized(a.language) < normalized(b.language)
            }
            if a.listRank != b.listRank { return a.listRank > b.listRank }
            let byName = a.displayName.localizedCaseInsensitiveCompare(b.displayName)
            return byName == .orderedSame ? a.id < b.id : byName == .orderedAscending
        }

        return Dictionary(grouping: shown) { baseLanguage($0.language) }
            .map { base, members in
                LanguageGroup(
                    id: base,
                    title: languageName(base),
                    isPreferred: preferredBases.contains(base),
                    voices: members.sorted(by: order))
            }
            .sorted { a, b in
                let (ra, rb) = (preferredBases.firstIndex(of: a.id), preferredBases.firstIndex(of: b.id))
                switch (ra, rb) {
                case let (x?, y?) where x != y: return x < y
                case (_?, nil): return true
                case (nil, _?): return false
                default:
                    let byTitle = a.title.localizedCaseInsensitiveCompare(b.title)
                    return byTitle == .orderedSame ? a.id < b.id : byTitle == .orderedAscending
                }
            }
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    // MARK: Picking

    /// An Enhanced or Premium voice for `language`, when one has been
    /// downloaded. iOS answers "a voice for this language" with the compact
    /// default even when a far better one is installed, so "Automatic" asks
    /// here first. Nil means nothing beats the system's own pick.
    ///
    /// The right accent wins over the better voice: exact locale, then the
    /// device's own, then quality, then name.
    static func upgrade(for language: String?, among voices: [SpeechVoice], preferred: [String]) -> SpeechVoice? {
        let wanted = language.map(normalized) ?? ""
        let base = language.map(baseLanguage) ?? preferred.first.map(baseLanguage) ?? ""
        guard !base.isEmpty else { return nil }
        let deviceTags = Set(preferred.map(normalized))

        func better(_ a: SpeechVoice, _ b: SpeechVoice) -> Bool {
            let (ea, eb) = (normalized(a.language) == wanted, normalized(b.language) == wanted)
            if ea != eb { return ea }
            let (da, db) = (deviceTags.contains(normalized(a.language)), deviceTags.contains(normalized(b.language)))
            if da != db { return da }
            if a.quality != b.quality { return a.quality > b.quality }
            return a.name == b.name ? a.id < b.id : a.name < b.name
        }
        return readable(voices)
            .filter { baseLanguage($0.language) == base && $0.quality > .standard }
            .sorted(by: better)
            .first
    }
}

/// The speaking-speed scale: 1× is the voice's normal pace.
enum SpeechRateMap {
    /// What the speed controls offer for a voice iOS ships with — the top is as fast as
    /// AVSpeechSynthesizer goes.
    static let range: ClosedRange<Double> = 0.5 ... 2.0
    /// A neural voice's audio is stretched by the player, so it can go further.
    static let neuralRange: ClosedRange<Double> = 0.5 ... 3.0
    static let step = 0.25

    static func range(neural: Bool) -> ClosedRange<Double> { neural ? neuralRange : range }

    /// Where the reader's speed button goes on each tap.
    static let cycle: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
    static let neuralCycle: [Double] = cycle + [2.5, 3]

    static func cycle(neural: Bool) -> [Double] { neural ? neuralCycle : cycle }

    /// AVSpeechUtterance.rate runs 0…1 with 0.5 the voice's normal pace. A multiplier is
    /// read off these points (straight lines between them): 2× is the fastest rate.
    private static let points: [(multiplier: Double, rate: Double)] = [
        (0.5, 0.25), (1, 0.5), (2, 1),
    ]

    /// `AVSpeechUtterance.rate` for a multiplier of the voice's normal pace.
    static func avRate(forMultiplier multiplier: Double) -> Float {
        guard multiplier.isFinite else { return 0.5 }
        guard let first = points.first, let last = points.last else { return 0.5 }
        if multiplier <= first.multiplier { return Float(first.rate) }
        if multiplier >= last.multiplier { return Float(last.rate) }
        for (low, high) in zip(points, points.dropFirst()) where multiplier <= high.multiplier {
            let t = (multiplier - low.multiplier) / (high.multiplier - low.multiplier)
            return Float(low.rate + t * (high.rate - low.rate))
        }
        return Float(last.rate)
    }

    /// "1×", "1.25×", "0.75×".
    static func label(_ multiplier: Double) -> String {
        String(format: "%.3g×", multiplier)
    }
}
