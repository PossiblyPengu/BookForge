import AVFoundation
import SwiftUI

/// The voices iOS has installed, as `SpeechVoice`s.
enum SystemVoices {
    static func installed() -> [SpeechVoice] {
        AVSpeechSynthesisVoice.speechVoices().map(SpeechVoice.init(system:))
    }

    /// The installed voices worth reading a book with.
    static func readable() -> [SpeechVoice] {
        SpeechVoices.readable(installed())
    }

    /// What "Automatic" speaks with on this phone: the best downloaded voice for the
    /// device's language, else the system's own pick.
    static func automatic(for language: String? = nil) -> AVSpeechSynthesisVoice? {
        let tag = language ?? Locale.preferredLanguages.first
        if let better = SpeechVoices.upgrade(for: tag, among: installed(), preferred: Locale.preferredLanguages),
           let voice = AVSpeechSynthesisVoice(identifier: better.id)
        {
            return voice
        }
        return tag.flatMap { AVSpeechSynthesisVoice(language: $0) } ?? AVSpeechSynthesisVoice(language: nil)
    }
}

extension SpeechVoice {
    init(system voice: AVSpeechSynthesisVoice) {
        // the same ones Readium's own voice list leaves out
        let novelty = voice.voiceTraits.contains(.isNoveltyVoice)
            || voice.voiceTraits.contains(.isPersonalVoice)
            || voice.identifier.contains(".eloquence.")
            || voice.identifier.hasPrefix("com.apple.speech.synthesis.voice.")
        let quality: Quality
        switch voice.quality {
        case .premium: quality = .premium
        case .enhanced: quality = .enhanced
        default: quality = .standard
        }
        self.init(id: voice.identifier, name: voice.name, language: voice.language, quality: quality, isNovelty: novelty)
    }
}

/// Speaks a short sample so a voice can be heard before it is chosen.
@MainActor
final class SpeechPreview: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let sample = "Chapter one. The lamplight fell across the open page, and the story began."

    /// The voice being sampled — its identifier, or "" for Automatic.
    @Published private(set) var playing: String?

    private let synthesizer = AVSpeechSynthesizer()
    /// The sample that was asked for last: a callback for an older one is not this one's end.
    private var current: AVSpeechUtterance?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Play the sample in `voice` (nil: Automatic) at `rate`; asking again for
    /// the voice that is playing stops it.
    func toggle(_ voice: SpeechVoice?, rate: Double) {
        let key = voice?.id ?? ""
        let wasPlaying = playing == key
        stop()
        guard !wasPlaying else { return }

        // an audiobook or read-aloud in progress gives way
        AudioFocus.shared.claim("preview")
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)

        let utterance = AVSpeechUtterance(string: Self.sample)
        utterance.voice = voice.flatMap { AVSpeechSynthesisVoice(identifier: $0.id) } ?? SystemVoices.automatic()
        utterance.rate = SpeechRateMap.avRate(forMultiplier: rate)
        current = utterance
        playing = key
        synthesizer.speak(utterance)
    }

    func stop() {
        guard playing != nil else { return }
        playing = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.ended(utterance) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.ended(utterance) }
    }

    private func ended(_ utterance: AVSpeechUtterance) {
        guard utterance === current else { return }
        current = nil
        playing = nil
        // let other apps' audio carry on — unless an audiobook or read-aloud of ours is still open
        if AudioFocus.shared.isIdle {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
