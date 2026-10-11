import AVFoundation
import Combine
import MediaPlayer
import ReadiumNavigator
import ReadiumShared
import UIKit

/// Tunes every utterance Readium's AVTTSEngine creates (its own configuration has no
/// rate setting, and it asks iOS for "a voice for this language", which answers with the
/// compact default even when a better one is installed).
final class SpeechTuning: AVTTSEngineDelegate {
    /// 1 = the voice's normal pace.
    var multiplier: Double = 1.0
    /// The voice the reader picked, if any: the one thing never to second-guess.
    var chosenVoiceID: String?
    private lazy var installed = SystemVoices.installed()

    func avTTSEngine(_ engine: AVTTSEngine, didCreateUtterance utterance: AVSpeechUtterance) {
        utterance.rate = SpeechRateMap.avRate(forMultiplier: multiplier)
        // Not the chosen voice (no choice, or a voice for another language than this
        // passage): "Automatic" — the best Enhanced/Premium voice for its language.
        guard let voice = utterance.voice, voice.identifier != chosenVoiceID,
              let better = SpeechVoices.upgrade(
                  for: voice.language, among: installed, preferred: Locale.preferredLanguages),
              better.id != voice.identifier,
              let upgraded = AVSpeechSynthesisVoice(identifier: better.id)
        else { return }
        utterance.voice = upgraded
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
    /// Seconds left on the sleep timer, nil when unset.
    @Published private(set) var sleepRemaining: TimeInterval?

    private let publication: Publication
    private weak var navigator: VisualNavigator?
    private let synthesizer: PublicationSpeechSynthesizer
    private let tuning: SpeechTuning
    /// The library record's values — the publication's own metadata can name
    /// a different edition than the title the user edited.
    private let displayTitle: String
    private let displayAuthor: String

    @Published private var spokenUtterance: Locator?
    private let spokenWord = PassthroughSubject<Locator, Never>()
    private var isTurning = false
    private var consecutiveFailures = 0
    private var subscriptions: Set<AnyCancellable> = []
    private var sleepTimer: Timer?
    private var sleepDeadline: Date?

    /// Surfaces problems the caller should show (e.g. utterances keep failing).
    var onError: ((String) -> Void)?
    /// Called when a chosen voice proved unusable and was dropped for the
    /// automatic one — the caller should clear its persisted voice setting.
    var onVoiceFallback: (() -> Void)?

    static func canSpeak(_ publication: Publication) -> Bool {
        PublicationSpeechSynthesizer.canSpeak(publication: publication)
    }

    init?(publication: Publication, navigator: VisualNavigator, settings: ReaderSettings,
          displayTitle: String, displayAuthor: String)
    {
        let tuning = SpeechTuning()
        tuning.multiplier = settings.speechRate
        tuning.chosenVoiceID = settings.voiceIdentifier
        guard let synthesizer = PublicationSpeechSynthesizer(
            publication: publication,
            config: .init(voiceIdentifier: settings.voiceIdentifier),
            engineFactory: { AVTTSEngine(delegate: tuning) }
        ) else { return nil }

        self.publication = publication
        self.navigator = navigator
        self.synthesizer = synthesizer
        self.tuning = tuning
        self.displayTitle = displayTitle
        self.displayAuthor = displayAuthor
        rate = settings.speechRate
        super.init()
        synthesizer.delegate = self
        AudioFocus.shared.register("readaloud") { [weak self] in self?.pauseForOtherAudio() }

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

    /// An audiobook started: hold the narration where it is.
    private func pauseForOtherAudio() {
        if case .playing = synthesizer.state { synthesizer.pause() }
    }

    /// Start from the first sentence on screen.
    func start() {
        AudioFocus.shared.claim("readaloud")
        isActive = true
        Task { @MainActor in
            let start = await navigator?.firstVisibleElementLocator() ?? navigator?.currentLocation
            synthesizer.start(from: start)
        }
        setUpNowPlaying()
    }

    func playPause() {
        if case .stopped = synthesizer.state { start(); return }
        // about to speak again (it was paused): take focus from anything else
        if case .playing = synthesizer.state {} else { AudioFocus.shared.claim("readaloud") }
        synthesizer.pauseOrResume()
    }

    func next() { synthesizer.next() }
    func previous() { synthesizer.previous() }

    func stop() {
        synthesizer.stop()
        AudioFocus.shared.unregister("readaloud")
        isActive = false
        setSleepTimer(minutes: nil)
        tearDownNowPlaying()
    }

    // MARK: - Sleep timer

    /// Stop read-aloud after the given number of minutes; nil cancels.
    func setSleepTimer(minutes: Int?) {
        sleepTimer?.invalidate()
        sleepTimer = nil
        guard let minutes, minutes > 0 else {
            sleepDeadline = nil
            sleepRemaining = nil
            return
        }
        sleepDeadline = Date().addingTimeInterval(TimeInterval(minutes) * 60)
        sleepRemaining = sleepDeadline?.timeIntervalSinceNow
        // 15s ticks — the label shows whole minutes so precision doesn't matter
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickSleepTimer() }
        }
    }

    private func tickSleepTimer() {
        guard let deadline = sleepDeadline else { return }
        let left = deadline.timeIntervalSinceNow
        if left <= 0 {
            stop()   // stop() also clears the timer
        } else {
            sleepRemaining = left
        }
    }

    /// Takes effect from the next sentence.
    func setRate(_ value: Double) {
        rate = value
        tuning.multiplier = value
    }

    var availableVoices: [TTSVoice] { synthesizer.availableVoices }

    func setVoice(_ identifier: String?) {
        synthesizer.config.voiceIdentifier = identifier
        tuning.chosenVoiceID = identifier
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
            MPMediaItemPropertyTitle: displayTitle,
            MPMediaItemPropertyArtist: displayAuthor,
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
            consecutiveFailures = 0
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
        // language). Carry on — but if everything fails (a missing/broken
        // voice), an unconditional next() silently burned through the whole
        // book. Three in a row is enough — but before giving up, drop a
        // chosen voice for the automatic one: iOS lists premium voices that
        // were never downloaded, and they fail silently. Retrying the same
        // utterance with the default voice fixes that whole class.
        consecutiveFailures += 1
        if consecutiveFailures >= 3 {
            if synthesizer.config.voiceIdentifier != nil {
                synthesizer.config.voiceIdentifier = nil
                tuning.chosenVoiceID = nil
                consecutiveFailures = 0
                onVoiceFallback?()
                synthesizer.start(from: utterance.locator)
                return
            }
            onError?("Read-aloud couldn't speak — the selected voice may not support this book's language.")
            stop()
            return
        }
        synthesizer.next()
    }
}
