import SwiftUI
import UIKit

extension HighlightColor {
    /// The tint Readium paints the highlight with.
    var uiColor: UIColor {
        switch self {
        case .yellow: return .systemYellow
        case .green: return .systemGreen
        case .blue: return .systemBlue
        case .pink: return .systemPink
        case .purple: return .systemPurple
        }
    }

    var color: Color { Color(uiColor) }
}
