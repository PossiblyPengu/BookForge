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
    private let neural: NeuralTTSEngine
    private let startup = AudioStartup()
    /// The library record's values — the publication's own metadata can name
    /// a different edition than the title the user edited.
    private let displayTitle: String
    private let displayAuthor: String

    /// What is being said now: the sentence, and the word in it.
    private struct Spoken: Equatable {
        var sentence: Locator?
        var word: Locator?

        /// The "word" is the whole of a sentence of several: the voice (or a neural voice told to follow
        /// only the sentence) named no word. That is no word to mark, and no line.
        var wordIsTheSentence: Bool {
            guard let said = word?.text.highlight, said == sentence?.text.highlight else { return false }
            return SpokenWords.words(in: said).count > 1
        }
    }

    @Published private var spoken = Spoken()
    /// The sentence a voice has named a word of, and the wait for it to: a voice that never does
    /// (some don't) would leave the first word lit for the whole sentence.
    private var namedAWordIn: Locator?
    private var wordTimeout: Task<Void, Never>?
    /// What is lit while it reads.
    @Published private(set) var highlights: ReadAloudHighlights
    /// Where the page is taken to follow the narration: the word being said in a paged book, the
    /// sentence in a scrolling one (a scrolling page that put each word at the top would never be still).
    private let followTarget = PassthroughSubject<Locator, Never>()
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
        // the voices iOS ships with, and the neural ones that have been downloaded
        let neural = NeuralTTSEngine(index: NeuralVoiceStore.shared.index)
        neural.speed = settings.speechRate
        neural.reportsWords = settings.highlights.needsWords
        guard let synthesizer = PublicationSpeechSynthesizer(
            publication: publication,
            config: .init(voiceIdentifier: settings.voiceIdentifier),
            engineFactory: { CompositeTTSEngine(system: AVTTSEngine(delegate: tuning), neural: neural) }
        ) else { return nil }

        self.publication = publication
        self.navigator = navigator
        self.synthesizer = synthesizer
        self.tuning = tuning
        self.neural = neural
        self.displayTitle = displayTitle
        self.displayAuthor = displayAuthor
        rate = settings.speechRate
        highlights = settings.highlights
        super.init()
        synthesizer.delegate = self
        // the next sentence is made while this one is said: ask the book what it is
        let lookahead = SentenceLookahead(publication: publication)
        neural.upcoming = { [weak self] text in
            guard let self, case let .playing(utterance, range: _) = self.synthesizer.state, utterance.text == text else { return nil }
            return await lookahead.sentence(after: utterance)
        }

        // light the sentence, the line and the word being spoken, as chosen
        if let decorable = navigator as? DecorableNavigator {
            Publishers.CombineLatest($spoken, $highlights)
                .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
                .sink { [weak self] spoken, highlights in
                    self?.paint(spoken, as: highlights, on: decorable)
                }
                .store(in: &subscriptions)
        }

        // follow the narration, turning pages mid-sentence when needed
        followTarget
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

    var isFollowingNarration: Bool { isTurning }

    private func registerAudio() {
        AudioFocus.shared.register(
            "readaloud", pause: { [weak self] in self?.pauseForOtherAudio() },
            remote: RemoteControls.Handlers(
                play: { [weak self] in self?.playPauseIfPaused() },
                pause: { [weak self] in self?.pauseForOtherAudio() },
                toggle: { [weak self] in self?.playPause() },
                next: { [weak self] in self?.next() },
                previous: { [weak self] in self?.previous() },
                refresh: { [weak self] in self?.publishNowPlaying() }))
    }

    private func playPauseIfPaused() {
        if case .playing = synthesizer.state { return }
        playPause()
    }

    /// An audiobook started: hold the narration where it is.
    private func pauseForOtherAudio() {
        startup.cancel()
        if case .playing = synthesizer.state { synthesizer.pause() }
    }

    /// Start from the first sentence on screen.
    func start() {
        registerAudio()
        AudioFocus.shared.claim("readaloud")
        isActive = true
        startup.start(locate: { [weak self] in
            await self?.navigator?.firstVisibleElementLocator() ?? self?.navigator?.currentLocation
        }, play: { [weak self] start in
            self?.synthesizer.start(from: start)
        })
        publishNowPlaying()
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
        startup.cancel()
        synthesizer.stop()
        // the synthesizer tells us it has stopped in a moment — by then this may be gone, and the
        // marks would stay on the page
        wordTimeout?.cancel()
        namedAWordIn = nil
        spoken = Spoken()
        neural.reset()
        NeuralSynth.shared.unload()   // the model's memory back
        AudioFocus.shared.unregister("readaloud")
        isActive = false
        setSleepTimer(minutes: nil)
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
        neural.speed = value
    }

    /// What is lit changes at once, even in the middle of a sentence.
    func setHighlights(_ value: ReadAloudHighlights) {
        guard value != highlights else { return }
        highlights = value
        neural.reportsWords = value.needsWords
    }

    var availableVoices: [TTSVoice] { synthesizer.availableVoices }

    func setVoice(_ identifier: String?) {
        synthesizer.config.voiceIdentifier = identifier
        tuning.chosenVoiceID = identifier
    }

    // MARK: - Highlights

    /// Whether the book is laid out as one long scrolling page.
    private var scrolls: Bool {
        (navigator as? EPUBNavigatorViewController)?.settings.scroll ?? false
    }

    /// If the voice has named no word of `sentence` in a moment, it won't: stop marking the first.
    private func waitForAWord(in sentence: Locator) {
        wordTimeout?.cancel()
        wordTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, let self, self.spoken.sentence == sentence, self.namedAWordIn != sentence else { return }
            self.spoken.word = nil
        }
    }

    /// What is on the page now, so that only what changed is sent to it.
    private var painted: (sentence: [Decoration], line: [Decoration], word: [Decoration]) = ([], [], [])

    /// A mark's id names its chapter file as well as its group. Readium tells only the file a changed
    /// decoration is now in, so with one id throughout, the marks in the file the voice has just left would
    /// stay on its page (to be found when the reader turns back); with the file in the id, a move to
    /// another file is a removal there and an addition here.
    private func markID(_ group: String, _ locator: Locator) -> Decoration.Id {
        "\(group)-\(locator.href.string)"
    }

    /// Put the sentence, line and word being said on the page as chosen — and take away the rest.
    private func paint(_ spoken: Spoken, as highlights: ReadAloudHighlights, on navigator: DecorableNavigator) {
        var sentence: [Decoration] = [], line: [Decoration] = [], word: [Decoration] = []
        if highlights.sentence, let locator = spoken.sentence {
            sentence = [Decoration(id: markID("tts", locator), locator: locator, style: .highlight(tint: .systemOrange))]
        }
        if let locator = spoken.word, !spoken.wordIsTheSentence {
            if highlights.word {
                // a navigator that doesn't know the stronger mark gets the plain highlight
                let style: Decoration.Style = navigator.supports(decorationStyle: .spokenWord)
                    ? .spokenWord(tint: .systemOrange) : .highlight(tint: .systemOrange)
                word = [Decoration(id: markID("tts-word", locator), locator: locator, style: style)]
            }
            if highlights.line, navigator.supports(decorationStyle: .spokenLine) {
                line = [Decoration(id: markID("tts-line", locator), locator: locator, style: .spokenLine)]
            }
        }
        if sentence != painted.sentence {
            navigator.apply(decorations: sentence, in: "tts")
            painted.sentence = sentence
        }
        if line != painted.line {
            navigator.apply(decorations: line, in: "tts-line")
            painted.line = line
        }
        if word != painted.word {
            navigator.apply(decorations: word, in: "tts-word")
            painted.word = word
        }
    }

    /// Where the first word of a sentence is on the page: what is lit until the voice names a word.
    private func firstWord(of utterance: PublicationSpeechSynthesizer.Utterance) -> Locator? {
        guard let range = SpokenWords.words(in: utterance.text).first?.range else { return nil }
        return utterance.locator.copy(text: { text in
            guard let highlight = text.highlight, highlight.startIndex <= range.lowerBound, highlight.endIndex >= range.upperBound else { return }
            text = text[range]
        })
    }

    // MARK: - Lock screen / Control Center

    /// The lock screen's title, author and cover. The buttons are `RemoteControls`'.
    private func publishNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: displayTitle,
            MPMediaItemPropertyArtist: displayAuthor,
        ]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        Task { @MainActor in
            if let image = try? await publication.cover().get() {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                // only if read-aloud still has the lock screen
                if RemoteControls.shared.activeOwner == "readaloud" {
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
            }
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
            wordTimeout?.cancel()
            namedAWordIn = nil
            spoken = Spoken()
        case let .playing(utterance, range: word):
            isActive = true
            isPlaying = true
            // the sentence, and in it the word being said — the first until the voice says which
            spoken = Spoken(sentence: utterance.locator, word: word ?? firstWord(of: utterance))
            if word != nil {
                namedAWordIn = utterance.locator
            } else {
                waitForAWord(in: utterance.locator)
            }
            if scrolls {
                followTarget.send(utterance.locator)
            } else if let word {
                followTarget.send(word)
            }
            // the state is published before every sentence, spoken or not — only a word being
            // spoken proves the voice works
            if let word {
                consecutiveFailures = 0
                #if DEBUG
                NSLog("PTReadAloud word %@", word.text.highlight ?? "?")
                #endif
            }
        case let .paused(utterance):
            isPlaying = false
            // stays where it was if this is the sentence that was being said
            let stayed = spoken.sentence == utterance.locator ? spoken.word : nil
            spoken = Spoken(sentence: utterance.locator, word: stayed ?? firstWord(of: utterance))
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
