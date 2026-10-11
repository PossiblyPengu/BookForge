import AVFoundation

/// Plays synthesized speech through AVAudioEngine at a speed that can change while it plays. The
/// audio is time-stretched rather than re-synthesized: VITS rounds phoneme durations to whole
/// frames, so asking the model for "twice as fast" gets about 1.3×; stretching is exact and keeps
/// the voice's pitch.
///
/// Sentences are queued behind each other. `enqueue` returns while the end of a sentence is still
/// playing, so the next one can be made in the meantime and follows without a gap. Audio is
/// scheduled in short pieces, so after an interruption (a call, a route change) it picks up from
/// the first piece not yet heard.
@MainActor
final class NeuralPlayer {
    static let shared = NeuralPlayer()

    private struct Piece {
        let id: Int
        let buffer: AVAudioPCMBuffer
    }

    private struct Waiter {
        let id: Int
        /// Resume once no more than this much playing time is left.
        let lead: TimeInterval
        let resume: (Bool) -> Void
    }

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let stretch = AVAudioUnitTimePitch()
    private var wiredRate: Double = 0

    /// Scheduled and not yet heard, oldest first.
    private var pending: [Piece] = []
    private var nextID = 0
    /// Bumped whenever the queue is rebuilt, so a callback for an old queue is ignored.
    private var generation = 0
    private var waiters: [Waiter] = []
    private var idleStop: Task<Void, Never>?

    /// 1 is the voice's own pace. Applies at once, even in the middle of a sentence.
    var speed: Double = 1 {
        didSet {
            stretch.rate = Float(min(max(speed, 0.25), 4))
            wake()   // the time left changes with the speed
        }
    }

    private init() {
        engine.attach(node)
        engine.attach(stretch)
        stretch.pitch = 0
        let center = NotificationCenter.default
        // the output changed under us (headphones out, a Bluetooth route): the engine has stopped
        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.pickUp() }
        }
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended
            else { return }
            Task { @MainActor in self?.pickUp() }
        }
    }

    // MARK: Playing

    /// Seconds of playing time still queued, at the current speed.
    var remaining: TimeInterval {
        guard wiredRate > 0 else { return 0 }
        let frames = pending.reduce(0.0) { $0 + Double($1.buffer.frameLength) }
        return frames / wiredRate / max(speed, 0.25)
    }

    /// Queue `samples` behind what is playing and wait until no more than `lead` seconds of it are
    /// left (0: until it has all been heard). True when that happened or `stop()` cut it short;
    /// false when the engine could not be started.
    func enqueue(_ samples: [Float], sampleRate: Double, lead: TimeInterval) async -> Bool {
        guard !Task.isCancelled, !samples.isEmpty, sampleRate > 0,
              let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        else { return true }
        idleStop?.cancel()
        if wiredRate != sampleRate {
            // a voice with another sample rate: what is playing finishes before the graph is rewired
            if !pending.isEmpty { _ = await wait(untilRemainingAtMost: 0) }
            guard !Task.isCancelled else { return true }
            wire(format)
        }
        for buffer in Self.buffers(of: samples, format: format) { schedule(buffer) }
        guard startEngine() else {
            failAll()
            return false
        }
        return await wait(untilRemainingAtMost: lead)
    }

    /// Queue `samples` and wait until all of it has been heard.
    func play(_ samples: [Float], sampleRate: Double) async -> Bool {
        await enqueue(samples, sampleRate: sampleRate, lead: 0)
    }

    /// Cut off everything that is queued; whoever is waiting returns.
    func stop() {
        generation += 1
        node.stop()
        pending.removeAll()
        let released = waiters
        waiters.removeAll()
        released.forEach { $0.resume(true) }
        scheduleIdleStop()
    }

    // MARK: Plumbing

    private func wait(untilRemainingAtMost lead: TimeInterval) async -> Bool {
        if remaining <= lead { return true }
        return await withCheckedContinuation { continuation in
            nextID += 1
            waiters.append(Waiter(id: nextID, lead: lead, resume: { continuation.resume(returning: $0) }))
        }
    }

    /// Resume whoever has waited long enough.
    private func wake() {
        guard !waiters.isEmpty else { return }
        let left = remaining
        let ready = waiters.filter { left <= $0.lead }
        guard !ready.isEmpty else { return }
        waiters.removeAll { waiter in ready.contains { $0.id == waiter.id } }
        ready.forEach { $0.resume(true) }
    }

    private func failAll() {
        generation += 1
        node.stop()
        pending.removeAll()
        let released = waiters
        waiters.removeAll()
        released.forEach { $0.resume(false) }
    }

    private func schedule(_ buffer: AVAudioPCMBuffer) {
        nextID += 1
        let piece = Piece(id: nextID, buffer: buffer)
        pending.append(piece)
        hand(piece, to: generation)
    }

    private func hand(_ piece: Piece, to queue: Int) {
        node.scheduleBuffer(piece.buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.heard(piece.id, generation: queue) }
        }
    }

    private func heard(_ id: Int, generation queue: Int) {
        guard queue == generation else { return }
        pending.removeAll { $0.id == id }
        wake()
        if pending.isEmpty { scheduleIdleStop() }
    }

    /// The engine runs on between sentences so they follow each other without a restart; it
    /// stops once nothing has come for a couple of seconds.
    private func scheduleIdleStop() {
        idleStop?.cancel()
        idleStop = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled, let self, self.pending.isEmpty, self.waiters.isEmpty else { return }
            self.node.stop()
            self.engine.stop()
        }
    }

    /// Connect player → stretch → mixer for this sample rate.
    private func wire(_ format: AVAudioFormat) {
        guard wiredRate != format.sampleRate else { return }
        if engine.isRunning { engine.stop() }
        engine.disconnectNodeOutput(node)
        engine.disconnectNodeOutput(stretch)
        engine.connect(node, to: stretch, format: format)
        engine.connect(stretch, to: engine.mainMixerNode, format: format)
        wiredRate = format.sampleRate
    }

    private func startEngine() -> Bool {
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return false }
        }
        node.play()
        return true
    }

    /// After an interruption or a route change: queue what has not been heard and carry on.
    private func pickUp() {
        guard !pending.isEmpty else { return }
        generation += 1
        node.stop()
        let queue = generation
        for piece in pending { hand(piece, to: queue) }
        if !startEngine() { failAll() }
    }

    /// Quarter-second pieces: small enough that a restart repeats little.
    private static func buffers(of samples: [Float], format: AVAudioFormat) -> [AVAudioPCMBuffer] {
        let size = max(Int(format.sampleRate / 4), 1)
        return stride(from: 0, to: samples.count, by: size).compactMap { start in
            let count = min(size, samples.count - start)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                  let channel = buffer.floatChannelData?[0]
            else { return nil }
            buffer.frameLength = AVAudioFrameCount(count)
            samples.withUnsafeBufferPointer { source in
                channel.update(from: source.baseAddress! + start, count: count)
            }
            return buffer
        }
    }
}
