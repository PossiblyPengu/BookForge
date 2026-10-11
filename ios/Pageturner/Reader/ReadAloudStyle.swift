import ReadiumNavigator
import UIKit

/// How read-aloud marks the word and the line it is on. (The sentence is Readium's ordinary highlight.)
/// The navigator is given the two templates when it is made (`ReaderModel`).
extension Decoration.Style.Id {
    /// The word being spoken.
    static let spokenWord: Decoration.Style.Id = "pt-spoken-word"
    /// The line of the page the voice is on.
    static let spokenLine: Decoration.Style.Id = "pt-spoken-line"
}

extension Decoration.Style {
    /// A stronger mark than the sentence's, so the word stands out inside it.
    static func spokenWord(tint: UIColor) -> Decoration.Style {
        Decoration.Style(id: .spokenWord, config: HighlightConfig(tint: tint))
    }

    static let spokenLine = Decoration.Style(id: .spokenLine)
}

extension HTMLDecorationTemplate {
    static func spokenWord(alpha: Double = 0.55) -> HTMLDecorationTemplate {
        HTMLDecorationTemplate(
            layout: .boxes,
            width: .wrap,
            element: { decoration in
                let config = decoration.style.config as? Decoration.Style.HighlightConfig
                let tint = config?.tint ?? .systemOrange
                return "<div class=\"pt-spoken-word\" style=\"background-color: \(tint.cssRGBA(alpha: alpha)) !important;\"/>"
            },
            stylesheet: """
            .pt-spoken-word {
                border-radius: 3px;
                box-sizing: border-box;
            }
            """)
    }

    /// A band across the page at the height of the line — in the colour of the text, so it suits every
    /// page theme — pulled in a little from the edges.
    static func spokenLine(opacity: Double = 0.12) -> HTMLDecorationTemplate {
        HTMLDecorationTemplate(
            layout: .boxes,
            width: .page,
            element: "<div class=\"pt-spoken-line\"/>",
            stylesheet: """
            .pt-spoken-line {
                background-color: currentColor !important;
                opacity: \(opacity);
                clip-path: inset(0 6px round 5px);
                box-sizing: border-box;
            }
            """)
    }
}

private extension UIColor {
    func cssRGBA(alpha: Double) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, ignored: CGFloat = 0
        getRed(&red, green: &green, blue: &blue, alpha: &ignored)
        return "rgba(\(Int((red * 255).rounded())), \(Int((green * 255).rounded())), \(Int((blue * 255).rounded())), \(alpha))"
    }
}
