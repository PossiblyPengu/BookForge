import Foundation
import ReadiumNavigator

/// Reading appearance and read-aloud preferences, shared by every book.
struct ReaderSettings: Codable, Equatable {
    enum ThemeChoice: String, Codable, CaseIterable, Identifiable {
        case paper, sepia, night
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        var readium: Theme {
            switch self {
            case .paper: return .light
            case .sepia: return .sepia
            case .night: return .dark
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

    var theme: ThemeChoice = .night
    var font: FontChoice = .book
    var fontSize: Double = 1.0
    var spacing: Spacing = .book
    var justify: Bool = true
    var scroll: Bool = false
    var margins: Double = 1.0

    /// Read-aloud speed multiplier (1 = the voice's normal pace).
    var speechRate: Double = 1.0
    var voiceIdentifier: String?

    var epubPreferences: EPUBPreferences {
        var p = EPUBPreferences()
        p.theme = theme.readium
        p.fontSize = fontSize
        p.scroll = scroll
        p.pageMargins = margins
        p.fontFamily = font.family
        p.lineHeight = spacing.lineHeight
        p.textAlign = justify ? .justify : .start
        p.hyphens = justify
        // Readium only applies typography overrides with publisher styles off.
        p.publisherStyles = false
        return p
    }

    // MARK: - Persistence

    private static let key = "reader-settings"

    static func load() -> ReaderSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(ReaderSettings.self, from: data)
        else { return ReaderSettings() }
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
