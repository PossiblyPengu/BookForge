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

    /// One of Siri's own voices, if iOS lists any for apps (it names them so).
    var isSiri: Bool {
        id.lowercased().contains("siri") || name.lowercased().hasPrefix("siri")
    }

    /// What the row says about it: "Siri", "Enhanced", "Premium".
    var badges: [String] {
        (isSiri ? ["Siri"] : []) + (quality.badge.map { [$0] } ?? [])
    }

    /// Better voices first; Siri's before the others of the same quality.
    var listRank: Int { quality.rawValue * 2 + (isSiri ? 1 : 0) }
    var searchTerms: [String] { badges }

    /// Natural enough to be worth looking for: not one of the compact voices every iPhone has.
    var isBetterThanCompact: Bool { quality > .standard || isSiri }
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

    /// How many of the readable voices are better than the compact ones every iPhone has, and so
    /// whether it is worth telling the reader how to add some.
    static func betterVoiceCount(in voices: [SpeechVoice]) -> Int {
        readable(voices).filter(\.isBetterThanCompact).count
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
    /// What the speed controls offer for a voice iOS ships with. Below 0.75× AVSpeechSynthesizer
    /// hardly gets slower (its slowest is about 0.7×).
    static let range: ClosedRange<Double> = 0.75 ... 3.0
    /// A neural voice's audio is stretched by the player, so it goes slower too.
    static let neuralRange: ClosedRange<Double> = 0.5 ... 3.0
    static let step = 0.25

    static func range(neural: Bool) -> ClosedRange<Double> { neural ? neuralRange : range }

    /// Where the reader's speed button goes on each tap.
    static let cycle: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    static let neuralCycle: [Double] = cycle

    static func cycle(neural: Bool) -> [Double] { neural ? neuralCycle : cycle }

    /// AVSpeechUtterance.rate runs 0…1 with 0.5 the voice's normal pace — and it is steeper above that
    /// than anyone would guess: 1.0 is about four times as fast. Measured on speech by the voices of
    /// the iOS Simulator (the Debug/SpeechProbe run in CI; seconds for the same text at each rate):
    ///
    ///     rate      0.2   0.3   0.5   0.6   0.7   0.8   0.9   1.0
    ///     seconds  18.2  16.9  13.0   8.2   6.2   4.7   3.7   3.2
    ///     × normal 0.72  0.77  1.00  1.59  2.11  2.80  3.51  4.03
    ///
    /// A multiplier is read off these points (straight lines between them), so that "2×" is twice
    /// as fast and not four times.
    private static let points: [(multiplier: Double, rate: Double)] = [
        (0.7, 0.2), (1, 0.5), (4, 1),
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

/// The sentence a voice is heard in: the same line in the voice's own language, so a French voice
/// isn't asked to read English.
enum SpeechSamples {
    static let english = "Chapter one. The lamplight fell across the open page, and the story began."

    private static let lines: [String: String] = [
        "en": english,
        "de": "Erstes Kapitel. Das Lampenlicht fiel auf die offene Seite, und die Geschichte begann.",
        "fr": "Chapitre un. La lumière de la lampe tombait sur la page ouverte, et l’histoire commença.",
        "es": "Capítulo uno. La luz de la lámpara cayó sobre la página abierta, y la historia comenzó.",
        "it": "Capitolo primo. La luce della lampada cadde sulla pagina aperta, e la storia ebbe inizio.",
        "pt": "Capítulo um. A luz da lâmpada caiu sobre a página aberta, e a história começou.",
        "nl": "Hoofdstuk één. Het lamplicht viel over de opengeslagen pagina, en het verhaal begon.",
        "ru": "Глава первая. Свет лампы упал на раскрытую страницу, и история началась.",
        "pl": "Rozdział pierwszy. Światło lampy padło na otwartą stronę i zaczęła się opowieść.",
        "uk": "Розділ перший. Світло лампи впало на розгорнуту сторінку, і почалася історія.",
        "cs": "První kapitola. Světlo lampy dopadlo na otevřenou stránku a příběh začal.",
        "sk": "Prvá kapitola. Svetlo lampy dopadlo na otvorenú stranu a príbeh sa začal.",
        "sl": "Prvo poglavje. Svetloba svetilke je padla na odprto stran in zgodba se je začela.",
        "sv": "Kapitel ett. Lampans sken föll över den uppslagna sidan, och berättelsen började.",
        "da": "Kapitel et. Lampelyset faldt over den opslåede side, og historien begyndte.",
        "nb": "Kapittel én. Lampelyset falt over den oppslåtte siden, og historien begynte.",
        "no": "Kapittel én. Lampelyset falt over den oppslåtte siden, og historien begynte.",
        "fi": "Ensimmäinen luku. Lampun valo osui avoimelle sivulle, ja tarina alkoi.",
        "tr": "Birinci bölüm. Lamba ışığı açık sayfaya düştü ve hikâye başladı.",
        "el": "Κεφάλαιο πρώτο. Το φως της λάμπας έπεσε πάνω στην ανοιχτή σελίδα και η ιστορία ξεκίνησε.",
        "hu": "Első fejezet. A lámpafény ráesett a nyitott oldalra, és a történet elkezdődött.",
        "ro": "Capitolul unu. Lumina lămpii a căzut pe pagina deschisă și povestea a început.",
        "ca": "Capítol u. La llum de la làmpada va caure sobre la pàgina oberta, i la història va començar.",
        "lv": "Pirmā nodaļa. Lampas gaisma krita uz atvērtās lappuses, un stāsts sākās.",
        "ar": "الفصل الأول. سقط ضوء المصباح على الصفحة المفتوحة، وبدأت الحكاية.",
        "vi": "Chương một. Ánh đèn rọi xuống trang sách đang mở, và câu chuyện bắt đầu.",
        "zh": "第一章。灯光落在翻开的书页上，故事开始了。",
    ]

    /// The sample for a BCP-47 tag ("fr-CA", "de_DE", nil) — English when there is none in that language.
    static func text(for tag: String?) -> String {
        lines[tag.map(SpeechVoices.baseLanguage) ?? ""] ?? english
    }
}
