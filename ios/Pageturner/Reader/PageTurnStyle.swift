import Foundation

/// How the page changes when it is turned by a tap on its edge (a swipe always follows the finger).
enum PageTurnStyle: String, Codable, CaseIterable, Identifiable {
    /// Readium's own slide.
    case slide
    /// The leaf follows the finger and peels like paper; taps turn the same
    /// way, on their own.
    case curl
    /// The page swings away on its spine, like the leaf of a book.
    case flip
    case fade

    var id: String { rawValue }

    var label: String {
        switch self {
        case .slide: return "Slide"
        case .curl: return "Page curl"
        case .flip: return "Book flip"
        case .fade: return "Fade"
        }
    }
}
