import Foundation
import ReadiumNavigator

/// Reading appearance and read-aloud preferences, shared by every book.
struct ReaderSettings: Codable, Equatable {
    /// The same five page palettes as the web reader (docs/js/reader.js), so a
    /// book looks the same on either. The raw values of the first three are what
    /// earlier builds saved.
    enum ThemeChoice: String, Codable, CaseIterable, Identifiable {
        case paper, sepia, gray, night, black
        var id: String { rawValue }
        var label: String { rawValue.capitalized }

        /// Page and text colour as 0xRRGGBB.
        var background: Int {
            switch self {
            case .paper: return 0xFBF8F2
            case .sepia: return 0xF4ECD9
            case .gray: return 0x4B4B4E
            case .night: return 0x131311
            case .black: return 0x000000
            }
        }

        var text: Int {
            switch self {
            case .paper: return 0x1D1A14
            case .sepia: return 0x3A2F1D
            case .gray: return 0xECEBE7
            case .night: return 0xE8E4DA
            case .black: return 0xCFCBC2
            }
        }

        /// Whether the page is dark — the reader's own chrome follows it.
        var isDark: Bool { self == .gray || self == .night || self == .black }

        var readium: Theme {
            switch self {
            case .paper: return .light
            case .sepia: return .sepia
            case .gray, .night, .black: return .dark
            }
        }
    }

    enum FontChoice: String, Codable, CaseIterable, Identifiable {
        case book, iowan, georgia, charter, palatino, sans
        var id: String { rawValue }
        var label: String {
            switch self {
            case .book: return "Book"
            case .iowan: return "Iowan"
            case .georgia: return "Georgia"
            case .charter: return "Charter"
            case .palatino: return "Palatino"
            case .sans: return "Sans"
            }
        }
        /// nil → the publisher's typeface
        var family: FontFamily? {
            switch self {
            case .book: return nil
            case .iowan: return .iowanOldStyle
            case .georgia: return .georgia
            case .charter: return FontFamily(rawValue: "Charter")
            case .palatino: return FontFamily(rawValue: "Palatino")
            case .sans: return .sansSerif
            }
        }
    }

    enum Spacing: String, Codable, CaseIterable, Identifiable {
        case book, tight, normal, loose
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        var lineHeight: Double? {
            switch self {
            case .book: return nil
            case .tight: return 1.3
            case .normal: return 1.5
            case .loose: return 1.8
            }
        }
    }

    /// How a page is laid out on screens wide enough for two. Meaningless in scroll mode.
    enum Columns: String, Codable, CaseIterable, Identifiable {
        case auto, one, two
        var id: String { rawValue }
        var label: String {
            switch self {
            case .auto: return "Two pages when wide"
            case .one: return "One page"
            case .two: return "Two pages"
            }
        }
        var readium: ColumnCount {
            switch self {
            case .auto: return .auto
            case .one: return .one
            case .two: return .two
            }
        }
    }

    var theme: ThemeChoice = .night
    var font: FontChoice = .book
    var fontSize: Double = 1.0
    var spacing: Spacing = .book
    var justify: Bool = true
    var scroll: Bool = false
    /// One page or a two-page spread when the screen is wide enough.
    var columns: Columns = .auto
    /// How a tap on the page edge turns the page.
    var pageTurn: PageTurnStyle = .slide
    /// Keep the screen on while a book is open.
    var keepAwake = true
    var margins: Double = 1.0

    /// Read-aloud speed multiplier (1 = the voice's normal pace).
    var speechRate: Double = 1.0
    var voiceIdentifier: String?
    /// What is lit while a book is read aloud.
    var highlights = ReadAloudHighlights()

    init() {}

    /// Every key is optional: settings saved by an earlier build lack the newer ones, and a missing
    /// key must not lose the reader's theme and fonts. Add new settings here as well.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        theme = try c.decodeIfPresent(ThemeChoice.self, forKey: .theme) ?? theme
        font = try c.decodeIfPresent(FontChoice.self, forKey: .font) ?? font
        fontSize = try c.decodeIfPresent(Double.self, forKey: .fontSize) ?? fontSize
        spacing = try c.decodeIfPresent(Spacing.self, forKey: .spacing) ?? spacing
        justify = try c.decodeIfPresent(Bool.self, forKey: .justify) ?? justify
        scroll = try c.decodeIfPresent(Bool.self, forKey: .scroll) ?? scroll
        columns = try c.decodeIfPresent(Columns.self, forKey: .columns) ?? columns
        pageTurn = try c.decodeIfPresent(PageTurnStyle.self, forKey: .pageTurn) ?? pageTurn
        keepAwake = try c.decodeIfPresent(Bool.self, forKey: .keepAwake) ?? keepAwake
        margins = try c.decodeIfPresent(Double.self, forKey: .margins) ?? margins
        speechRate = try c.decodeIfPresent(Double.self, forKey: .speechRate) ?? speechRate
        voiceIdentifier = try c.decodeIfPresent(String.self, forKey: .voiceIdentifier)
        highlights = try c.decodeIfPresent(ReadAloudHighlights.self, forKey: .highlights) ?? highlights
    }

    var epubPreferences: EPUBPreferences {
        var p = EPUBPreferences()
        p.theme = theme.readium
        p.backgroundColor = Color(rawValue: theme.background)
        p.textColor = Color(rawValue: theme.text)
        p.fontSize = fontSize
        p.scroll = scroll
        p.columnCount = scroll ? nil : columns.readium
        p.pageMargins = margins
        p.fontFamily = font.family
        p.lineHeight = spacing.lineHeight
        p.textAlign = justify ? .justify : .start
        p.hyphens = justify
        // Readium only applies typography overrides with publisher styles off.
        p.publisherStyles = false
        return p
    }

    /// What a PDF can take from the Reading sheet: the page colour and scrolling.
    var pdfPreferences: PDFPreferences {
        PDFPreferences(backgroundColor: Color(rawValue: theme.background), scroll: scroll)
    }

    // MARK: - Persistence

    private static let key = "reader-settings"

    /// The speed the chosen voice can do: a bad value is no speed, and a device voice can't go as slow
    /// as a neural one (so a speed set for a neural voice is brought into range when the voice changes).
    var fittedSpeechRate: Double {
        let neural = voiceIdentifier.flatMap(NeuralVoice.key(fromID:)) != nil
        let range = SpeechRateMap.range(neural: neural)
        return speechRate.isFinite ? min(max(speechRate, range.lowerBound), range.upperBound) : 1
    }

    static func load() -> ReaderSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              var settings = try? JSONDecoder().decode(ReaderSettings.self, from: data)
        else { return ReaderSettings() }
        settings.speechRate = settings.fittedSpeechRate
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
