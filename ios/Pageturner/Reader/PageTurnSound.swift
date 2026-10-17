import AudioToolbox
import Foundation

/// The rustle of a page, played when it turns. A system sound on purpose: it follows the ringer switch and
/// volume (a silent phone stays silent), mixes with an audiobook or read-aloud instead of interrupting it,
/// and never touches the app's audio session.
@MainActor
final class PageTurnSound {
    static let shared = PageTurnSound()
    private var sound: SystemSoundID = 0

    private init() {
        guard let url = Bundle.main.url(forResource: "pageturn", withExtension: "wav") else {
            Log.error("sound", "pageturn.wav is not in the app")
            return
        }
        AudioServicesCreateSystemSoundID(url as CFURL, &sound)
    }

    func play() {
        guard sound != 0 else { return }
        AudioServicesPlaySystemSound(sound)
    }
}
