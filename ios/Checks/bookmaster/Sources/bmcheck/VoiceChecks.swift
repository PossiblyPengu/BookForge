import Foundation

// Checks for the read-aloud voice logic: the installed-voice list (grouping, order,
// search), which voice "Automatic" prefers, and the speed scale. No servers needed.

private let languageNames = ["en": "English", "fr": "French", "de": "German", "ja": "Japanese", "zh": "Chinese"]
private let regionNames = [
    "US": "United States", "GB": "United Kingdom", "AU": "Australia", "FR": "France", "CA": "Canada",
    "DE": "Germany", "JP": "Japan", "CN": "China", "TW": "Taiwan", "HK": "Hong Kong",
]

private func voice(
    _ id: String, _ name: String, _ language: String,
    _ quality: SpeechVoice.Quality = .standard, novelty: Bool = false
) -> SpeechVoice {
    SpeechVoice(id: id, name: name, language: language, quality: quality, isNovelty: novelty)
}

@MainActor
func runVoiceChecks() {
    section("Read-aloud voices: language tags")
    check("base language", SpeechVoices.baseLanguage("en-GB") == "en" && SpeechVoices.baseLanguage("en_GB") == "en"
          && SpeechVoices.baseLanguage("EN-gb") == "en" && SpeechVoices.baseLanguage("zh-Hans-CN") == "zh"
          && SpeechVoices.baseLanguage("") == "")
    check("region", SpeechVoices.region("en-GB") == "GB" && SpeechVoices.region("en_us") == "US"
          && SpeechVoices.region("zh-Hans-CN") == "CN" && SpeechVoices.region("ar-001") == "001")
    check("no region when there is none", SpeechVoices.region("pt") == nil && SpeechVoices.region("sr-Latn") == nil && SpeechVoices.region("") == nil)
    check("tags compare equal however they are spelt", SpeechVoices.normalized("en_GB") == SpeechVoices.normalized("EN-gb"))

    section("Read-aloud voices: names and the list")
    check("a downloaded voice drops its quality suffix (the badge says it)",
          voice("1", "Zoe (Premium)", "en-US", .premium).displayName == "Zoe"
          && voice("2", "Daniel (Enhanced)", "en-GB", .enhanced).displayName == "Daniel")
    check("…only when the quality agrees", voice("3", "Zoe (Premium)", "en-US").displayName == "Zoe (Premium)"
          && voice("4", "Zoe (Enhanced)", "en-US", .premium).displayName == "Zoe (Enhanced)")
    check("a plain name or a parenthetical region is left alone", voice("5", "Samantha", "en-US").displayName == "Samantha"
          && voice("6", "Eddy (English (UK))", "en-GB").displayName == "Eddy (English (UK))")

    let catalog = [
        voice("us.samantha", "Samantha", "en-US"),
        voice("us.ava", "Ava (Premium)", "en-US", .premium),
        voice("us.evan", "Evan (Enhanced)", "en-US", .enhanced),
        voice("gb.daniel", "Daniel", "en-GB"),
        voice("gb.kate", "Kate (Enhanced)", "en-GB", .enhanced),
        voice("au.karen", "Karen", "en-AU"),
        voice("fr.thomas", "Thomas", "fr-FR"),
        voice("fr.amelie", "Amélie (Enhanced)", "fr-FR", .enhanced),
        voice("de.anna", "Anna", "de-DE"),
        voice("ja.kyoko", "Kyoko", "ja-JP"),
        voice("zh.tingting", "Tingting", "zh-CN"),
        voice("us.bubbles", "Bubbles", "en-US", novelty: true),
        voice("us.whisper", "Whisper (Premium)", "en-US", .premium, novelty: true),
    ]
    func groups(_ voices: [SpeechVoice], query: String = "", preferred: [String]) -> [SpeechVoices.LanguageGroup<SpeechVoice>] {
        SpeechVoices.groups(
            voices, query: query, preferred: preferred,
            languageName: { languageNames[$0] ?? $0 }, regionName: { regionNames[$0] })
    }
    let readable = SpeechVoices.readable(catalog)
    check("novelty voices are left out", readable.count == 11 && !readable.contains { $0.isNovelty }, "\(readable.count)")

    let ordered = groups(readable, preferred: ["en-GB", "fr-FR"])
    check("the device's languages come first, in the order it ranks them", ordered.prefix(2).map(\.id) == ["en", "fr"], "\(ordered.map(\.id))")
    check("the rest follow alphabetically by their name", ordered.dropFirst(2).map(\.title) == ["Chinese", "German", "Japanese"], "\(ordered.map(\.title))")
    check("preferred groups say so", ordered.map(\.isPreferred) == [true, true, false, false, false], "\(ordered.map(\.isPreferred))")
    check("groups are titled by language name", ordered.first?.title == "English")
    let english = ordered[0].voices.map(\.id)
    check("the device's own locale first, better voices before compact ones",
          english.prefix(2) == ["gb.kate", "gb.daniel"], "\(english)")
    check("other regions stay together, by region, then quality, then name",
          english.dropFirst(2) == ["au.karen", "us.ava", "us.evan", "us.samantha"], "\(english)")
    check("with no preferred language everything is by name", groups(readable, preferred: []).map(\.title) == ["Chinese", "English", "French", "German", "Japanese"],
          "\(groups(readable, preferred: []).map(\.title))")
    check("a script and region in the device tag still pick the language", groups(readable, preferred: ["zh-Hans-CN"]).first?.id == "zh")
    check("a duplicate name and language orders by id, not by luck",
          groups([voice("b", "Alex", "en-US"), voice("a", "Alex", "en-US")], preferred: []).first?.voices.map(\.id) == ["a", "b"])
    check("nothing installed, nothing listed", groups([], preferred: ["en-US"]).isEmpty)

    section("Read-aloud voices: search")
    func hits(_ q: String) -> [String] { groups(readable, query: q, preferred: ["en-US"]).flatMap(\.voices).map(\.id).sorted() }
    check("by name", hits("kate") == ["gb.kate"], "\(hits("kate"))")
    check("…ignoring case and surrounding space", hits("  KATE ") == ["gb.kate"])
    check("…and accents either way", hits("amelie") == ["fr.amelie"] && hits("Amélie") == ["fr.amelie"], "\(hits("amelie"))")
    check("by language name", hits("french") == ["fr.amelie", "fr.thomas"], "\(hits("french"))")
    check("by region name", hits("united") == ["gb.daniel", "gb.kate", "us.ava", "us.evan", "us.samantha"], "\(hits("united"))")
    check("by language tag", hits("de-DE") == ["de.anna"], "\(hits("de-DE"))")
    check("by quality", hits("premium") == ["us.ava"] && hits("enhanced") == ["fr.amelie", "gb.kate", "us.evan"], "\(hits("premium")) \(hits("enhanced"))")
    check("no match, no groups", hits("zzz").isEmpty)
    check("an empty query is everything", hits("").count == 11)

    section("Read-aloud voices: what Automatic prefers")
    func up(_ language: String?, _ preferred: [String], among: [SpeechVoice]? = nil) -> String? {
        SpeechVoices.upgrade(for: language, among: among ?? catalog, preferred: preferred)?.id
    }
    check("the book's own accent wins", up("en-GB", ["en-US"]) == "gb.kate", "\(String(describing: up("en-GB", ["en-US"])))")
    check("a bare language takes the device's accent", up("en", ["en-US"]) == "us.ava", "\(String(describing: up("en", ["en-US"])))")
    check("…and the better voice when the device's accent has none to offer", up("en", ["en-AU"]) == "us.ava")
    check("a missing region falls to the device's locale", up("fr-CA", ["fr-FR"]) == "fr.amelie")
    check("nothing better than the system's own pick: nil", up("de-DE", ["en-US"]) == nil && up("ja-JP", ["ja-JP"]) == nil)
    check("no language asks for the device's", up(nil, ["fr-FR"]) == "fr.amelie" && up(nil, []) == nil)
    check("a novelty voice is never offered", up("en-US", ["en-US"]) == "us.ava")
    check("an unknown language: nil", up("xx", ["en-US"]) == nil)
    check("a tie is settled by name", up("en-US", [], among: [voice("2", "Zed", "en-US", .enhanced), voice("1", "Alf", "en-US", .enhanced)]) == "1")
    check("tags are compared however they are spelt", up("en_gb", ["EN-us"]) == "gb.kate")

    section("Read-aloud voices: the speed scale")
    let steps = stride(from: 0.5, through: 3.0, by: 0.05).map { SpeechRateMap.avRate(forMultiplier: $0) }
    check("faster never sounds slower", zip(steps, steps.dropFirst()).allSatisfy { $0 <= $1 })
    check("1× is the voice's normal pace", SpeechRateMap.avRate(forMultiplier: 1) == 0.5)
    check("the top speed is the fastest rate the engine has, and nothing is offered beyond it",
          SpeechRateMap.avRate(forMultiplier: SpeechRateMap.range.upperBound) == 1 && SpeechRateMap.avRate(forMultiplier: 5) == 1)
    check("always a valid AVSpeechUtterance rate", steps.allSatisfy { $0 >= 0 && $0 <= 1 }
          && SpeechRateMap.avRate(forMultiplier: 0) >= 0 && SpeechRateMap.avRate(forMultiplier: 1_000) <= 1
          && SpeechRateMap.avRate(forMultiplier: -3) >= 0)
    check("junk input is the normal pace", SpeechRateMap.avRate(forMultiplier: .nan) == 0.5 && SpeechRateMap.avRate(forMultiplier: .infinity) <= 1)
    let offered = Array(stride(from: SpeechRateMap.range.lowerBound, through: SpeechRateMap.range.upperBound, by: SpeechRateMap.step))
    check("every speed the controls offer is a different speed",
          Set(offered.map { SpeechRateMap.avRate(forMultiplier: $0) }).count == offered.count, "\(offered.map { SpeechRateMap.avRate(forMultiplier: $0) })")
    check("the button's steps climb and sit inside the range",
          zip(SpeechRateMap.cycle, SpeechRateMap.cycle.dropFirst()).allSatisfy { $0 < $1 }
          && SpeechRateMap.cycle.allSatisfy { SpeechRateMap.range.contains($0) })
    check("labels", SpeechRateMap.label(1) == "1×" && SpeechRateMap.label(1.25) == "1.25×" && SpeechRateMap.label(0.75) == "0.75×"
          && SpeechRateMap.label(1.75) == "1.75×" && SpeechRateMap.label(2.5) == "2.5×",
          "\([1, 1.25, 0.75, 1.75, 2.5].map(SpeechRateMap.label))")
}
