import Foundation
import Observation

/// Where Siri, Shortcuts and Spotlight hand a request over to the app. They can
/// arrive before the first screen exists (a cold launch from Siri), so the
/// request waits here until the shell picks it up.
@Observable
@MainActor
final class IntentRouter {
    static let shared = IntentRouter()

    enum Request: Equatable {
        case open(UUID)
        case continueReading
    }

    var request: Request?

    private init() {}
}
