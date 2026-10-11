import AVFoundation

/// Plays synthesized speech through AVAudioEngine — one utterance at a time — at a speed that
/// can change while it plays. The audio is time-stretched rather than re-synthesized: VITS
/// rounds phoneme durations to whole frames, so asking the model for "twice as fast" gets
/// about 1.3×; stretching is exact and keeps the voice's pitch.
///
/// The audio is queued in half-second chunks, so after an interruption (a call, a route
/// change) it picks up from the first chunk not yet heard.
@MainActor
final class NeuralPlayer {
    static let shared = NeuralPlayer()

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let stretch = AVAudioUnitTimePitch()
    private var wiredRate: Double = 0

    private var chunks: [AVAudioPCMBuffer] = []
    /// The first chunk not yet heard.
    private var next = 0
    /// Bumped whenever the queue is rebuilt, so a callback for an old queue is ignored.
    private var generation = 0
    private var finish: ((Bool) -> Void)?
    private var idleStop: Task<Void, Never>?

    /// 1 is the voice's own pace. Applies at once, even in the middle of a sentence.
    var speed: Double = 1 {
        didSet { stretch.rate = Float(min(max(speed, 0.25), 4)) }
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

    /// Play `samples` and wait for them. True when they were heard or cut short by `stop()`
    /// (or by cancelling the caller); false when the engine could not be started.
    func play(_ samples: [Float], sampleRate: Double) async -> Bool {
        stop()
        guard !Task.isCancelled, !samples.isEmpty, sampleRate > 0,
              let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        else { return true }
        idleStop?.cancel()
        wire(format)
        chunks = Self.chunks(of: samples, format: format)
        next = 0
        generation += 1
        let queue = generation
        return await withCheckedContinuation { continuation in
            finish = { continuation.resume(returning: $0) }
            schedule(from: 0, generation: queue)
            if !startEngine() { complete(false) }
        }
    }

    /// Cut off whatever is playing; its `play` returns.
    func stop() {
        generation += 1
        node.stop()
        complete(true)
    }

    // MARK: Plumbing

    private func complete(_ ok: Bool) {
        let done = finish
        finish = nil
        done?(ok)
        if finish == nil { scheduleIdleStop() }
    }

    /// The engine runs on between sentences so they follow each other without a restart; it
    /// stops once nothing has come for a couple of seconds.
    private func scheduleIdleStop() {
        idleStop?.cancel()
        idleStop = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled, let self, self.finish == nil else { return }
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

    private func schedule(from start: Int, generation queue: Int) {
        guard start < chunks.count else { return }
        for index in start..<chunks.count {
            node.scheduleBuffer(chunks[index], at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in self?.heard(index, generation: queue) }
            }
        }
    }

    private func heard(_ index: Int, generation queue: Int) {
        guard queue == generation else { return }
        next = max(next, index + 1)
        if next >= chunks.count { complete(true) }
    }

    /// After an interruption or a route change: queue what has not been heard and carry on.
    private func pickUp() {
        guard finish != nil else { return }
        generation += 1
        node.stop()
        schedule(from: next, generation: generation)
        if !startEngine() { complete(false) }
    }

    private static func chunks(of samples: [Float], format: AVAudioFormat) -> [AVAudioPCMBuffer] {
        let size = max(Int(format.sampleRate / 2), 1)
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
