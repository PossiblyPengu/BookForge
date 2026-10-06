import AVFoundation
import MediaPlayer
import UIKit

/// Audiobook playback on AVPlayer. One AVPlayer, items swapped manually on
/// track boundaries — simpler than AVQueuePlayer for backwards seeks across
/// tracks (the queue discards finished items).
@MainActor
final class AudioPlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var position: TimeInterval = 0   // seconds from book start
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var trackIndex = 0
    @Published var rate: Float {
        didSet {
            if isPlaying { player?.rate = rate }
            UserDefaults.standard.set(Double(rate), forKey: "audioPlaybackRate")
        }
    }
    /// Seconds left on the sleep timer, nil when unset.
    @Published private(set) var sleepRemaining: TimeInterval?
    @Published private(set) var coverImage: UIImage?
    @Published var notice: String?

    private let book: Book
    private let library: LibraryStore
    private let urls: [URL]
    private var player: AVPlayer?
    private var trackOffsets: [TimeInterval] = []
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var sleepTimer: Timer?
    private var sleepDeadline: Date?
    private var lastSavedPosition: TimeInterval = -1
    private var artworkItem: MPMediaItemArtwork?

    init(book: Book, library: LibraryStore) {
        self.book = book
        self.library = library
        urls = library.fileURLs(for: book)
        let saved = UserDefaults.standard.double(forKey: "audioPlaybackRate")
        rate = saved > 0 ? Float(saved) : 1.0
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
        trackOffsets = offsets
        duration = total
        coverImage = library.cover(for: book)
        guard !urls.isEmpty else {
            notice = "No audio files found for this book."
            return
        }
        load(track: 0)
        let target = book.audioPosition ?? (book.progression.map { $0 * total }) ?? 0
        if target > 1 { seek(to: target, resume: false) }
        configureSession()
        setUpNowPlaying()
    }

    private func load(track index: Int) {
        guard urls.indices.contains(index) else { return }
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
            savePosition()
            return
        }
        load(track: next)
        if isPlaying { resumePlayback() }
    }

    // MARK: - Controls

    func togglePlay() { isPlaying ? pause() : play() }

    func play() {
        guard player != nil else { return }
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
        player?.pause()
        isPlaying = false
        savePosition()
        MPNowPlayingInfoCenter.default().playbackState = .paused
    }

    func skip(by seconds: TimeInterval) {
        seek(to: position + seconds, resume: isPlaying)
    }

    /// Global position seek — crosses track boundaries when needed.
    func seek(to target: TimeInterval, resume: Bool) {
        guard !trackOffsets.isEmpty else { return }
        let t = min(max(target, 0), duration)
        var track = trackIndex
        for (i, off) in trackOffsets.enumerated() {
            let next = i + 1 < trackOffsets.count ? trackOffsets[i + 1] : duration
            if t >= off && t < next { track = i; break }
        }
        if track != trackIndex { load(track: track) }
        let local = t - trackOffsets[track]
        player?.seek(to: CMTime(seconds: local, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: .zero)
        position = t
        if resume { resumePlayback() }
        updateNowPlaying()
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

    var trackNames: [String] {
        if book.trackTitles.count == urls.count { return book.trackTitles }
        return urls.map { $0.deletingPathExtension().lastPathComponent }
    }

    // MARK: - Sleep timer

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
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickSleepTimer() }
        }
    }

    private func tickSleepTimer() {
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
        setSleepTimer(minutes: nil)
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        let center = MPRemoteCommandCenter.shared()
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                        center.nextTrackCommand, center.previousTrackCommand,
                        center.skipForwardCommand, center.skipBackwardCommand]
        {
            command.removeTarget(nil)
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func savePosition() {
        var b = book
        b.audioPosition = position
        b.progression = duration > 0 ? position / duration : nil
        b.lastOpenedAt = Date()
        library.update(b)
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
                // persist about every 10s so resume survives a force-quit
                if self.isPlaying, abs(self.position - self.lastSavedPosition) >= 10 {
                    self.lastSavedPosition = self.position
                    self.savePosition()
                }
            }
        }
    }

    private func setUpNowPlaying() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.play(); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.togglePlay(); return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.nextTrack(); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.previousTrack(); return .success }
        center.skipForwardCommand.preferredIntervals = [30]
        center.skipForwardCommand.addTarget { [weak self] _ in self?.skip(by: 30); return .success }
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.addTarget { [weak self] _ in self?.skip(by: -15); return .success }
        updateNowPlaying()
    }

    private func updateNowPlaying() {
        if artworkItem == nil, let image = library.cover(for: book) {
            artworkItem = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: book.title,
            MPMediaItemPropertyArtist: book.author,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? rate : 0,
        ]
        if let artworkItem { info[MPMediaItemPropertyArtwork] = artworkItem }
        if urls.count > 1 {
            info[MPMediaItemPropertyAlbumTrackNumber] = trackIndex + 1
            info[MPMediaItemPropertyAlbumTrackCount] = urls.count
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
