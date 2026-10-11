import AVFoundation
import ReadiumNavigator
import ReadiumShared

extension NeuralVoice {
    /// How Readium sees it: a voice with an identifier it hands back when told to speak with it.
    var ttsVoice: TTSVoice {
        let level: TTSVoice.Quality
        switch quality {
        case .xLow: level = .low
        case .low: level = .medium
        case .medium: level = .high
        case .high: level = .higher
        }
        return TTSVoice(
            identifier: id, language: Language(code: .bcp47(language)), name: displayName,
            gender: .unspecified, quality: level)
    }
}

/// Readium text-to-speech with the neural voices that have been downloaded: sherpa-onnx makes
/// each sentence, `NeuralPlayer` plays it.
final class NeuralTTSEngine: TTSEngine {
    enum Failure: Error, LocalizedError {
        case notInstalled
        case playback

        var errorDescription: String? {
            switch self {
            case .notInstalled: return "That voice isn’t on this iPhone any more."
            case .playback: return "The sound couldn’t be started."
            }
        }
    }

    private let index: NeuralVoiceIndex

    /// How fast to speak (1 is the voice's own pace); changes apply to what is playing too.
    @MainActor var speed: Double = 1 {
        didSet { NeuralPlayer.shared.speed = speed }
    }

    init(index: NeuralVoiceIndex) {
        self.index = index
    }

    var availableVoices: [TTSVoice] {
        index.all.map(\.voice.ttsVoice)
    }

    func voiceWithIdentifier(_ identifier: String) -> TTSVoice? {
        index.entry(forID: identifier)?.voice.ttsVoice
    }

    @MainActor
    func speak(
        _ utterance: TTSUtterance,
        onSpeakRange: @escaping (Range<String.Index>) -> Void
    ) async -> Result<Void, TTSError> {
        let text = utterance.text
        guard case let .left(chosen) = utterance.voiceOrLanguage, let entry = index.entry(forID: chosen.identifier) else {
            return .failure(.other(Failure.notInstalled))
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .success(()) }
        do {
            let audio = try await NeuralSynth.shared.generate(text: text, directory: entry.directory, info: entry.info)
            // paused, skipped or stopped while it was being made
            if Task.isCancelled { return .success(()) }
            NeuralPlayer.shared.speed = speed
            // the whole sentence at once: the highlight is by sentence, and the page follows it
            onSpeakRange(text.startIndex ..< text.endIndex)
            let played = await withTaskCancellationHandler {
                await NeuralPlayer.shared.play(audio.samples, sampleRate: audio.sampleRate)
            } onCancel: {
                Task { @MainActor in NeuralPlayer.shared.stop() }
            }
            return played ? .success(()) : .failure(.other(Failure.playback))
        } catch {
            return .failure(.other(error))
        }
    }
}

/// Speaks with whichever engine owns the voice: the neural voices that were downloaded, or the
/// ones iOS ships with. Anything without a chosen neural voice goes to the system.
final class CompositeTTSEngine: TTSEngine {
    private let system: AVTTSEngine
    private let neural: NeuralTTSEngine

    init(system: AVTTSEngine, neural: NeuralTTSEngine) {
        self.system = system
        self.neural = neural
    }

    var availableVoices: [TTSVoice] {
        system.availableVoices + neural.availableVoices
    }

    func voiceWithIdentifier(_ identifier: String) -> TTSVoice? {
        NeuralVoice.key(fromID: identifier) != nil
            ? neural.voiceWithIdentifier(identifier)
            : system.voiceWithIdentifier(identifier)
    }

    @MainActor
    func speak(
        _ utterance: TTSUtterance,
        onSpeakRange: @escaping (Range<String.Index>) -> Void
    ) async -> Result<Void, TTSError> {
        if case let .left(voice) = utterance.voiceOrLanguage, NeuralVoice.key(fromID: voice.identifier) != nil {
            return await neural.speak(utterance, onSpeakRange: onSpeakRange)
        }
        return await system.speak(utterance, onSpeakRange: onSpeakRange)
    }
}
