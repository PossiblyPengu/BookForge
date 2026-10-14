import AVFoundation
import MediaPlayer
import UIKit
import Combine

/// Audiobook playback on AVPlayer. One AVPlayer, items swapped manually on
/// track boundaries — simpler than AVQueuePlayer for backwards seeks across
/// tracks (the queue discards finished items).
@MainActor
final class AudioPlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var position: TimeInterval = 0   // seconds from book start
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var trackIndex = 0
    /// Chapters on the book's timeline — a file each for a multi-file book, the
    /// embedded markers for a single m4b. Empty when the audio has none.
    @Published private(set) var chapters: [AudioChapter] = []
    /// When it was paused, for the little rewind on playing again; and when an interruption took it away.
    private var pausedAt: Date?
    private var interruptedWhilePlaying: Date?

    @Published var rate: Float {
        didSet {
            if isPlaying { player?.rate = rate }
            UserDefaults.standard.set(Double(rate), forKey: "audioPlaybackRate")
            updateNowPlaying()   // the lock screen's clock runs at this speed
        }
    }
    /// Seconds left on the sleep timer, nil when unset.
    @Published private(set) var sleepRemaining: TimeInterval?
    @Published private(set) var coverImage: UIImage?
    @Published var notice: String?

    private var book: Book
    private let library: LibraryStore
    private let urls: [URL]
    private var player: AVPlayer?
    private var trackOffsets: [TimeInterval] = []
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var sleepTimer: Timer?
    private var sleepDeadline: Date?
    private var lastSavedPosition: TimeInterval = -1
    private var lastChapterIndex: Int?
    private var artworkItem: MPMediaItemArtwork?
    /// Where and when this listen began, for the BookMaster session push.
    private var sessionStart: (at: Date, progression: Double)?
    /// Set once the files have been measured and the starting place found. Until then there is
    /// no position to save — an early close would have written "the start" over the real one.
    private var opened = false
    private var closed = false
    /// What was last written to the library, to tell a change from outside (a restart, a jump to
    /// BookMaster's place) from our own saves.
    private var checkpoint = PlaybackProgress()
    private var libraryChanges: AnyCancellable?
    /// Consecutive seconds the player said "paused" while we believed it was playing.
    private var stalledTicks = 0
    private var routeObserver: NSObjectProtocol?

    init(book: Book, library: LibraryStore) {
        self.book = book
        self.library = library
        urls = library.fileURLs(for: book)
        let saved = UserDefaults.standard.double(forKey: "audioPlaybackRate")
        rate = saved > 0 ? Float(saved) : 1.0
        libraryChanges = library.$books.sink { [weak self] books in
            guard let self, !self.closed, let latest = books.first(where: { $0.id == self.book.id }) else { return }
            self.adopt(latest)
        }
    }

    var trackCount: Int { urls.count }
    var bookTitle: String { book.title }
    var bookAuthor: String { book.author }

    func open() async {
        // cumulative offsets turn "track i, t seconds" into a global position
        var offsets: [TimeInterval] = []
        var total: TimeInterval = 0
        for url in urls {
            offsets.append(total)
            let d = (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0
            total += d
        }
        guard !closed else { return }
        trackOffsets = offsets
        duration = total
        chapters = urls.count > 1
            ? AudioChapters.fromTracks(titles: trackNames, offsets: offsets, duration: total)
            : await Self.embeddedChapters(of: urls.first, duration: total)
        guard !closed else { return }
        coverImage = library.cover(for: book)
        guard !urls.isEmpty else {
            notice = "No audio files found for this book."
            return
        }
        load(track: 0)
        let target = book.audioPosition ?? (book.progression.map { $0 * total }) ?? 0
        if target > 1 { seek(to: target, resume: false) }
        _ = checkpoint.adopt(position: book.audioPosition, progression: book.progression, playhead: position)
        opened = true
        configureSession()
        AudioFocus.shared.register("audiobook", pause: { [weak self] in self?.pause() }, remote: remoteHandlers)
        updateNowPlaying()
        // a call or alarm stops the audio — pause too, so the sitting ends there
        // instead of counting the interruption as listening
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            Task { @MainActor in
                guard let self else { return }
                switch type {
                case .began:
                    let wasPlaying = self.isPlaying
                    self.pause()
                    self.interruptedWhilePlaying = wasPlaying ? Date() : nil
                case .ended:
                    // a call, Siri or an alarm that is over: carry on, unless it has been so long that
                    // the reader has surely moved on (or anything else paused the book meanwhile)
                    defer { self.interruptedWhilePlaying = nil }
                    if options.contains(.shouldResume), let at = self.interruptedWhilePlaying,
                       Date().timeIntervalSince(at) < 300 {
                        try? AVAudioSession.sharedInstance().setActive(true)
                        self.play()
                    }
                @unknown default: break
                }
            }
        }
        // headphones unplugged: iOS has already stopped the player — make the screen agree
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
            else { return }
            Task { @MainActor in self?.pause() }
        }
    }

    /// The library's record of this book changed from outside — a restart, "Go to N%" from
    /// BookMaster's offer — while the player was already loaded: follow it, rather than carry on
    /// from the old place and write that back over it.
    func adopt(_ latest: Book) {
        book = latest
        guard opened, duration > 0,
              checkpoint.adopt(position: latest.audioPosition, progression: latest.progression, playhead: position) else { return }
        let target = latest.audioPosition ?? (latest.progression.map { $0 * duration }) ?? 0
        sessionStart = nil
        if abs(target - position) > 2 { seek(to: target, resume: isPlaying) }
    }

    /// What the lock screen, headset and Control Center buttons do while this owns them.
    private var remoteHandlers: RemoteControls.Handlers {
        RemoteControls.Handlers(
            play: { [weak self] in self?.play() },
            pause: { [weak self] in self?.pause() },
            toggle: { [weak self] in self?.togglePlay() },
            next: { [weak self] in self?.skipForwardAChapter() },
            previous: { [weak self] in self?.skipBackAChapter() },
            skipForward: { [weak self] in self?.skip(by: AppPrefs.skipForward) },
            skipBackward: { [weak self] in self?.skip(by: -AppPrefs.skipBack) },
            seekTo: { [weak self] t in self?.seek(to: t, resume: self?.isPlaying ?? false) },
            setRate: { [weak self] r in self?.rate = r },
            refresh: { [weak self] in self?.updateNowPlaying() })
    }

    private func load(track index: Int) {
        guard urls.indices.contains(index) else { return }
        pausedAt = nil
        trackIndex = index
        let item = AVPlayerItem(url: urls[index])
        if let player { player.replaceCurrentItem(with: item) } else { player = AVPlayer(playerItem: item) }
        position = trackOffsets[index]
        observeEnd(of: item)
        updateNowPlaying()
    }

    private func observeEnd(of item: AVPlayerItem) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.advance() }
        }
    }

    private func advance() {
        let next = trackIndex + 1
        guard next < urls.count else {
            // finished: clamp at the end, persist, stop
            pause()
            position = duration
            savePosition(force: true)
            return
        }
        load(track: next)
        if isPlaying { resumePlayback() }
    }

    // MARK: - Controls

    func togglePlay() { isPlaying ? pause() : play() }

    func play() {
        guard player != nil else { return }
        // pressing play on a book that has finished starts it again
        if duration > 0, position >= duration - 0.5 { seek(to: 0, resume: false) }
        // after a break, a little back from where it stopped (never before the start of the chapter)
        if let at = pausedAt {
            pausedAt = nil
            let back = AudioChapters.smartRewind(pausedFor: Date().timeIntervalSince(at))
            if back > 0, duration > 0, position < duration - 0.5 {
                let floor = chapters.count > 1 ? (AudioChapters.index(at: position, in: chapters).map { chapters[$0].start } ?? 0) : 0
                seek(to: max(position - back, floor), resume: false)
            }
        }
        AudioFocus.shared.claim("audiobook")
        if sessionStart == nil, duration > 0 { sessionStart = (Date(), position / duration) }
        resumePlayback()
        isPlaying = true
        startTimeObserver()
        MPNowPlayingInfoCenter.default().playbackState = .playing
        updateNowPlaying()
    }

    /// `play()` resets rate to `defaultRate` — reapply the user's speed.
    private func resumePlayback() {
        player?.play()
        player?.rate = rate
    }

    func pause() {
        if isPlaying { pausedAt = Date() }
        interruptedWhilePlaying = nil   // anything but an interruption's own pause cancels carrying on afterwards
        player?.pause()
        isPlaying = false
        stalledTicks = 0
        savePosition(force: true)
        endBookMasterSession()
        MPNowPlayingInfoCenter.default().playbackState = .paused
        updateNowPlaying()   // the clock stops, and the lock screen should say so
    }

    func skip(by seconds: TimeInterval) {
        seek(to: position + seconds, resume: isPlaying)
    }

    /// Global position seek — crosses track boundaries when needed.
    func seek(to target: TimeInterval, resume: Bool) {
        guard !trackOffsets.isEmpty else { return }
        pausedAt = nil   // a deliberate move is not a place to be stepped back from
        let t = min(max(target, 0), duration)
        let track = AudioChapters.trackIndex(at: t, offsets: trackOffsets) ?? trackIndex
        if track != trackIndex { load(track: track) }
        let local = t - trackOffsets[track]
        player?.seek(to: CMTime(seconds: local, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: .zero)
        position = t
        if resume { resumePlayback() }
        updateNowPlaying()
    }

    /// Chapters when the book has them, otherwise files.
    func skipForwardAChapter() {
        if chapters.count > 1 { nextChapter() } else { nextTrack() }
    }

    func skipBackAChapter() {
        if chapters.count > 1 { previousChapter() } else { previousTrack() }
    }

    func nextTrack() {
        goToTrack(trackIndex + 1)
    }

    func previousTrack() {
        // restart the track unless we're already at its head
        if position - trackOffsets[trackIndex] > 3 {
            seek(to: trackOffsets[trackIndex], resume: isPlaying)
        } else {
            goToTrack(trackIndex - 1)
        }
    }

    /// Jump to a track (chapter picker / next / previous).
    func goToTrack(_ index: Int) {
        guard urls.indices.contains(index), index != trackIndex else { return }
        let wasPlaying = isPlaying
        load(track: index)
        if wasPlaying { resumePlayback() }
    }

    // MARK: - Chapters

    var currentChapterIndex: Int? { AudioChapters.index(at: position, in: chapters) }

    var currentChapter: AudioChapter? { currentChapterIndex.map { chapters[$0] } }

    /// Seconds left in the chapter being played.
    var chapterRemaining: TimeInterval? {
        currentChapter.map { max($0.end - position, 0) }
    }

    func goToChapter(_ index: Int) {
        guard chapters.indices.contains(index) else { return }
        seek(to: chapters[index].start, resume: isPlaying)
    }

    func nextChapter() {
        guard let current = currentChapterIndex, current + 1 < chapters.count else { return }
        goToChapter(current + 1)
    }

    /// Restart the chapter, or go back one when already at its head.
    func previousChapter() {
        guard let target = AudioChapters.previousTarget(position: position, in: chapters) else { return }
        goToChapter(target)
    }

    /// The markers inside a single audio file (m4b/m4a chapter tracks). A file
    /// without any, or one that won't say, has no chapters.
    private static func embeddedChapters(of url: URL?, duration: TimeInterval) async -> [AudioChapter] {
        guard let url else { return [] }
        let asset = AVURLAsset(url: url)
        guard let groups = try? await asset.loadChapterMetadataGroups(
            bestMatchingPreferredLanguages: Locale.preferredLanguages), !groups.isEmpty
        else { return [] }
        var raw: [(title: String, start: TimeInterval, end: TimeInterval?)] = []
        for group in groups {
            let titles = AVMetadataItem.metadataItems(from: group.items, filteredByIdentifier: .commonIdentifierTitle)
            var title = ""
            if let item = titles.first ?? group.items.first, let text = try? await item.load(.stringValue) {
                title = text
            }
            let end = group.timeRange.end.seconds
            raw.append((title, group.timeRange.start.seconds, end.isFinite ? end : nil))
        }
        return AudioChapters.normalise(raw, duration: duration)
    }

    var trackNames: [String] {
        if book.trackTitles.count == urls.count { return book.trackTitles }
        // the files are stored under internal names — never show those
        return urls.indices.map { "Part \($0 + 1)" }
    }

    // MARK: - Sleep timer

    /// In chapter-end mode the deadline is re-aimed at the boundary each tick,
    /// so a seek moves it instead of stranding it (and a pause freezes it).
    private var sleepAtChapterEnd = false

    func setSleepTimer(minutes: Int?) {
        sleepAtChapterEnd = false
        sleepTimer?.invalidate()
        sleepTimer = nil
        guard let minutes, minutes > 0 else {
            sleepDeadline = nil
            sleepRemaining = nil
            return
        }
        sleepDeadline = Date().addingTimeInterval(TimeInterval(minutes) * 60)
        sleepRemaining = sleepDeadline?.timeIntervalSinceNow
        armSleepTimer()
    }

    /// "Stop at the end of this chapter" — the same countdown, aimed at the
    /// chapter boundary rather than a wall-clock length.
    func setSleepTimerToChapterEnd() {
        guard chapterEnd != nil else { return }
        sleepAtChapterEnd = true
        armSleepTimer()
        tickSleepTimer()
    }

    private func armSleepTimer() {
        sleepTimer?.invalidate()
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickSleepTimer() }
        }
    }

    /// Where the chapter being played ends — nil for a book without chapters.
    private var chapterEnd: TimeInterval? {
        guard chapters.count > 1, let i = currentChapterIndex else { return nil }
        return i + 1 < chapters.count ? chapters[i + 1].start : duration
    }

    private func tickSleepTimer() {
        if sleepAtChapterEnd, let end = chapterEnd {
            // media time → wall clock: at 2× the boundary arrives twice as soon
            let wall = max(0, end - position) / Double(max(rate, 0.1))
            sleepDeadline = Date().addingTimeInterval(wall)
        }
        guard let deadline = sleepDeadline else { return }
        let left = deadline.timeIntervalSinceNow
        if left <= 0 {
            setSleepTimer(minutes: nil)
            pause()
        } else {
            sleepRemaining = left
        }
    }

    // MARK: - Teardown

    /// Persist and release — call from the view's onDisappear.
    func close() {
        savePosition()
        pause()
        closed = true
        libraryChanges?.cancel()
        AudioFocus.shared.unregister("audiobook")   // the lock-screen buttons pass on, or are cleared
        setSleepTimer(minutes: nil)
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        routeObserver = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func savePosition(force: Bool = false) {
        // before the files are measured there is no place to save; after a close there is nothing to follow
        guard opened, !closed, duration > 0, checkpoint.maySave(at: position) else { return }
        let progression = position / duration
        checkpoint.saved(position: position, progression: progression)
        // the record as it is now: an edit made while this was loaded (a title, a shelf) must survive
        library.mutate(book.id) { stored in
            stored.audioPosition = position
            stored.progression = progression
            stored.lastOpenedAt = Date()
        }
        if let latest = library.books.first(where: { $0.id == book.id }) { book = latest }
        let ref = book.bookMasterRef
        Task {
            await BookMaster.shared.syncProgress(
                bookKey: book.id.uuidString, ref: ref, percent: progression, isAudio: true, force: force,
                pinned: { [weak self] id in self?.pin(id) })
        }
    }

    private func pin(_ id: String) {
        guard book.bookmasterId != id else { return }
        book.bookmasterId = id
        library.updateBookMaster(book.id) { $0.bookmasterId = id }
    }

    /// Tell BookMaster how far this listen got. Under half a percent is not a session.
    private func endBookMasterSession() {
        guard let start = sessionStart, duration > 0 else { return }
        sessionStart = nil
        let end = position / duration
        let minutes = Date().timeIntervalSince(start.at) / 60
        let moved = (end - start.progression) * 100 >= 0.5
        // the local log keeps any real listen — even a long one that went nowhere
        if moved || minutes >= 2 {
            ReadingLog.shared.record(book: book, minutes: minutes, from: start.progression, to: end, audio: true)
        }
        guard moved else { return }
        let ref = book.bookMasterRef
        Task {
            await BookMaster.shared.syncSession(
                ref: ref, percentStart: start.progression, percentEnd: end,
                minutes: minutes, at: Date())
        }
    }

    // MARK: - Plumbing

    private func configureSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    private func startTimeObserver() {
        guard timeObserver == nil else { return }
        timeObserver = player?.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 2), queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                self.position = self.trackOffsets[self.trackIndex] + time.seconds
                // the lock screen shows the chapter's name — keep it current
                if self.currentChapterIndex != self.lastChapterIndex {
                    self.lastChapterIndex = self.currentChapterIndex
                    self.updateNowPlaying()
                }
                // iOS paused the player under us (an unplugged headset, another app's audio) and nobody told us
                if self.isPlaying, self.player?.timeControlStatus == .paused {
                    self.stalledTicks += 1
                    if self.stalledTicks >= 2 { self.pause() }
                } else {
                    self.stalledTicks = 0
                }
                // persist about every 10s so resume survives a force-quit
                if self.isPlaying, abs(self.position - self.lastSavedPosition) >= 10 {
                    self.lastSavedPosition = self.position
                    self.savePosition()
                }
            }
        }
    }

    private func updateNowPlaying() {
        if artworkItem == nil, let image = library.cover(for: book) {
            artworkItem = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: currentChapter?.title ?? book.title,
            MPMediaItemPropertyAlbumTitle: book.title,
            MPMediaItemPropertyArtist: book.author,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? rate : 0,
        ]
        if let artworkItem { info[MPMediaItemPropertyArtwork] = artworkItem }
        if let index = currentChapterIndex {
            info[MPNowPlayingInfoPropertyChapterNumber] = index
            info[MPNowPlayingInfoPropertyChapterCount] = chapters.count
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
