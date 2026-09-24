import AVFoundation
import Combine
import MediaPlayer
import ReadiumNavigator
import ReadiumShared
import UIKit

/// Sets the speaking rate on every utterance Readium's AVTTSEngine creates
/// (its own configuration has no rate setting).
final class SpeechRate: AVTTSEngineDelegate {
    var multiplier: Double = 1.0

    func avTTSEngine(_ engine: AVTTSEngine, didCreateUtterance utterance: AVSpeechUtterance) {
        let rate = Float(Double(AVSpeechUtteranceDefaultSpeechRate) * multiplier)
        utterance.rate = min(max(rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }
}

/// Read-aloud on Readium's PublicationSpeechSynthesizer and the system voices.
/// Speech runs through AVSpeechSynthesizer on a .playback audio session, so it
/// keeps going with the screen locked and shows on the lock screen.
@MainActor
final class ReadAloud: NSObject, ObservableObject {
    @Published private(set) var isActive = false   // controls shown
    @Published private(set) var isPlaying = false
    @Published private(set) var rate: Double

    private let publication: Publication
    private weak var navigator: VisualNavigator?
    private let synthesizer: PublicationSpeechSynthesizer
    private let speechRate: SpeechRate

    @Published private var spokenUtterance: Locator?
    private let spokenWord = PassthroughSubject<Locator, Never>()
    private var isTurning = false
    private var subscriptions: Set<AnyCancellable> = []

    static func canSpeak(_ publication: Publication) -> Bool {
        PublicationSpeechSynthesizer.canSpeak(publication: publication)
    }

    init?(publication: Publication, navigator: VisualNavigator, settings: ReaderSettings) {
        let speechRate = SpeechRate()
        speechRate.multiplier = settings.speechRate
        guard let synthesizer = PublicationSpeechSynthesizer(
            publication: publication,
            config: .init(voiceIdentifier: settings.voiceIdentifier),
            engineFactory: { AVTTSEngine(delegate: speechRate) }
        ) else { return nil }

        self.publication = publication
        self.navigator = navigator
        self.synthesizer = synthesizer
        self.speechRate = speechRate
        rate = settings.speechRate
        super.init()
        synthesizer.delegate = self

        // highlight the sentence being spoken
        if let decorable = navigator as? DecorableNavigator {
            $spokenUtterance
                .removeDuplicates()
                .sink { locator in
                    let decorations = locator.map {
                        [Decoration(id: "tts", locator: $0, style: .highlight(tint: .systemOrange))]
                    } ?? []
                    decorable.apply(decorations: decorations, in: "tts")
                }
                .store(in: &subscriptions)
        }

        // follow the narration, turning pages mid-sentence when needed
        spokenWord
            .removeDuplicates()
            .throttle(for: .seconds(1), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] locator in
                guard let self, !self.isTurning, let navigator = self.navigator else { return }
                self.isTurning = true
                Task { @MainActor in
                    _ = await navigator.go(to: locator, options: NavigatorGoOptions(animated: true))
                    self.isTurning = false
                }
            }
            .store(in: &subscriptions)
    }

    // MARK: - Controls

    /// Start from the first sentence on screen.
    func start() {
        isActive = true
        Task { @MainActor in
            let start = await navigator?.firstVisibleElementLocator() ?? navigator?.currentLocation
            synthesizer.start(from: start)
        }
        setUpNowPlaying()
    }

    func playPause() {
        if case .stopped = synthesizer.state { start() } else { synthesizer.pauseOrResume() }
    }

    func next() { synthesizer.next() }
    func previous() { synthesizer.previous() }

    func stop() {
        synthesizer.stop()
        isActive = false
        tearDownNowPlaying()
    }

    /// Takes effect from the next sentence.
    func setRate(_ value: Double) {
        rate = value
        speechRate.multiplier = value
    }

    var availableVoices: [TTSVoice] { synthesizer.availableVoices }

    func setVoice(_ identifier: String?) {
        synthesizer.config.voiceIdentifier = identifier
    }

    // MARK: - Lock screen / Control Center

    private func setUpNowPlaying() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.togglePlayPauseCommand.removeTarget(nil)
        center.nextTrackCommand.removeTarget(nil)
        center.previousTrackCommand.removeTarget(nil)
        center.playCommand.addTarget { [weak self] _ in
            self?.synthesizer.resume(); return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.synthesizer.pause(); return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.synthesizer.pauseOrResume(); return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.synthesizer.next(); return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.synthesizer.previous(); return .success
        }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: publication.metadata.title ?? "Reading aloud",
            MPMediaItemPropertyArtist: publication.metadata.authors.map(\.name).joined(separator: ", "),
        ]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        Task { @MainActor in
            if let image = try? await publication.cover().get() {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    private func tearDownNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let center = MPRemoteCommandCenter.shared()
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                        center.nextTrackCommand, center.previousTrackCommand]
        {
            command.removeTarget(nil)
        }
    }
}

extension ReadAloud: PublicationSpeechSynthesizerDelegate {
    func publicationSpeechSynthesizer(
        _ synthesizer: PublicationSpeechSynthesizer,
        stateDidChange state: PublicationSpeechSynthesizer.State
    ) {
        switch state {
        case .stopped:
            isPlaying = false
            spokenUtterance = nil
        case let .playing(utterance, range: word):
            isActive = true
            isPlaying = true
            spokenUtterance = utterance.locator
            if let word { spokenWord.send(word) }
        case let .paused(utterance):
            isPlaying = false
            spokenUtterance = utterance.locator
        }
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    func publicationSpeechSynthesizer(
        _ synthesizer: PublicationSpeechSynthesizer,
        utterance: PublicationSpeechSynthesizer.Utterance,
        didFailWithError error: PublicationSpeechSynthesizer.Error
    ) {
        // A sentence the engine couldn't speak (e.g. no voice for its
        // language). Carry on with the next one rather than stopping.
        synthesizer.next()
    }
}
