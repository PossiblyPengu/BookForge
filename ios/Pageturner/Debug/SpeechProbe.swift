#if DEBUG
import AVFoundation

/// CI simulator run (`-PTDebugSpeechProbe 1`): reports which voices the runtime has and how
/// long a passage takes at each AVSpeechUtterance rate, so the speed scale in `SpeechRateMap`
/// can be fitted to what AVSpeechSynthesizer really does. The result is NSLog lines that
/// start with "PTSpeechProbe" (collected into the run's logs). Debug builds only.
enum SpeechProbe {
    private static var kept: [AnyObject] = []

    static let passage = "Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world."

    static func run() async {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        var counts = [0, 0, 0]
        for voice in voices {
            switch voice.quality {
            case .premium: counts[2] += 1
            case .enhanced: counts[1] += 1
            default: counts[0] += 1
            }
        }
        NSLog("PTSpeechProbe voices=%d standard=%d enhanced=%d premium=%d", voices.count, counts[0], counts[1], counts[2])
        NSLog("PTSpeechProbe deviceLanguages=%@", Locale.preferredLanguages.joined(separator: ","))
        NSLog("PTSpeechProbe languages=%@", Set(voices.map(\.language)).sorted().joined(separator: ","))
        for voice in voices.prefix(40) {
            NSLog("PTSpeechProbe voice id=%@ name=%@ lang=%@ quality=%d", voice.identifier, voice.name, voice.language, voice.quality.rawValue)
        }

        let voice = SystemVoices.automatic(for: "en-US")
        NSLog("PTSpeechProbe automatic=%@", voice?.identifier ?? "none")
        for rate in [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as [Float] {
            let utterance = AVSpeechUtterance(string: passage)
            utterance.voice = voice
            utterance.rate = rate
            let meter = Meter()
            kept.append(meter)   // never freed: TextToSpeech keeps calling back into it
            let result = await meter.measure(utterance, timeout: 10)
            NSLog("PTSpeechProbe rate=%.2f seconds=%.2f buffers=%d", Double(rate), result.seconds, result.buffers)
        }

        // the scale as the app uses it: does "2×" really take half the time of "1×"?
        var normal = 0.0
        for multiplier in [1.0, 0.75, 1.25, 1.5, 2.0, 2.5, 3.0] {
            let utterance = AVSpeechUtterance(string: passage)
            utterance.voice = voice
            utterance.rate = SpeechRateMap.avRate(forMultiplier: multiplier)
            let meter = Meter()
            kept.append(meter)
            let result = await meter.measure(utterance, timeout: 10)
            if multiplier == 1 { normal = result.seconds }
            NSLog("PTSpeechProbe scale multiplier=%.2f rate=%.3f seconds=%.2f speed=%.2f",
                  multiplier, Double(utterance.rate), result.seconds, result.seconds > 0 ? normal / result.seconds : 0)
        }
        NSLog("PTSpeechProbe done")
    }

    /// Renders an utterance to audio buffers (no sound) and adds up how long they are.
    private final class Meter: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var seconds = 0.0
        private var buffers = 0
        private var continuation: CheckedContinuation<(seconds: Double, buffers: Int), Never>?
        private let synthesizer = AVSpeechSynthesizer()

        func measure(_ utterance: AVSpeechUtterance, timeout: TimeInterval) async -> (seconds: Double, buffers: Int) {
            synthesizer.delegate = self
            return await withCheckedContinuation { continuation in
                lock.lock()
                self.continuation = continuation
                lock.unlock()
                synthesizer.write(utterance) { [weak self] buffer in
                    guard let self, let pcm = buffer as? AVAudioPCMBuffer else { return }
                    if pcm.frameLength == 0 {
                        self.finish()
                        return
                    }
                    self.lock.lock()
                    self.seconds += Double(pcm.frameLength) / pcm.format.sampleRate
                    self.buffers += 1
                    self.lock.unlock()
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish() }
            }
        }

        private func finish() {
            lock.lock()
            let pending = continuation
            continuation = nil
            let result = (seconds: seconds, buffers: buffers)
            lock.unlock()
            pending?.resume(returning: result)
        }

        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish() }
        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish() }
    }
}
#endif
