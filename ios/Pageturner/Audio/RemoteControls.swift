import MediaPlayer

/// The lock screen, headset and Control Center buttons — one set of handlers for the whole app.
/// Whatever is making sound (the audiobook, or read-aloud) owns the buttons; when it lets go, the
/// one before it gets them back. They used to be added and wiped by each player in turn, so after
/// reading aloud the audiobook's buttons did nothing until the book was reopened.
///
/// Owners are registered through `AudioFocus`; `claim` there is what makes one the active owner.
@MainActor
final class RemoteControls {
    static let shared = RemoteControls()

    struct Handlers {
        var play: (() -> Void)?
        var pause: (() -> Void)?
        var toggle: (() -> Void)?
        var next: (() -> Void)?
        var previous: (() -> Void)?
        var skipForward: (() -> Void)?
        var skipBackward: (() -> Void)?
        /// Put this owner's Now Playing information back on the lock screen.
        var refresh: (() -> Void)?
    }

    private var handlers: [String: Handlers] = [:]
    /// Oldest first: the last one is the active owner.
    private var order: [String] = []
    private var wired = false

    private init() {}

    var activeOwner: String? { order.last }

    func register(_ id: String, _ new: Handlers) {
        handlers[id] = new
        order.removeAll { $0 == id }
        order.append(id)
        wireIfNeeded()
        apply()
    }

    /// `id` is about to make sound: it gets the buttons.
    func activate(_ id: String) {
        guard handlers[id] != nil, order.last != id else { return }
        order.removeAll { $0 == id }
        order.append(id)
        apply()
        handlers[id]?.refresh?()
    }

    func unregister(_ id: String) {
        guard handlers[id] != nil else { return }
        let wasActive = order.last == id
        handlers[id] = nil
        order.removeAll { $0 == id }
        apply()
        guard wasActive else { return }
        if let next = order.last {
            handlers[next]?.refresh?()
        } else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
        }
    }

    // MARK: Plumbing

    private var active: Handlers? { order.last.flatMap { handlers[$0] } }

    /// Every command is wired once and asks who owns the buttons at the moment it is pressed.
    private func wireIfNeeded() {
        guard !wired else { return }
        wired = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.run(\.play) ?? .commandFailed }
        center.pauseCommand.addTarget { [weak self] _ in self?.run(\.pause) ?? .commandFailed }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.run(\.toggle) ?? .commandFailed }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.run(\.next) ?? .commandFailed }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.run(\.previous) ?? .commandFailed }
        center.skipForwardCommand.addTarget { [weak self] _ in self?.run(\.skipForward) ?? .commandFailed }
        center.skipBackwardCommand.addTarget { [weak self] _ in self?.run(\.skipBackward) ?? .commandFailed }
        center.skipForwardCommand.preferredIntervals = [30]
        center.skipBackwardCommand.preferredIntervals = [15]
    }

    private func run(_ action: KeyPath<Handlers, (() -> Void)?>) -> MPRemoteCommandHandlerStatus {
        guard let handler = active?[keyPath: action] else { return .noActionableNowPlayingItem }
        handler()
        return .success
    }

    /// Only the buttons the owner can answer are enabled.
    private func apply() {
        let center = MPRemoteCommandCenter.shared()
        let owner = active
        center.playCommand.isEnabled = owner?.play != nil
        center.pauseCommand.isEnabled = owner?.pause != nil
        center.togglePlayPauseCommand.isEnabled = owner?.toggle != nil
        center.nextTrackCommand.isEnabled = owner?.next != nil
        center.previousTrackCommand.isEnabled = owner?.previous != nil
        center.skipForwardCommand.isEnabled = owner?.skipForward != nil
        center.skipBackwardCommand.isEnabled = owner?.skipBackward != nil
    }
}
