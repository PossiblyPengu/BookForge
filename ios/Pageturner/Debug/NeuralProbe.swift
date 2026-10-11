#if DEBUG
import Foundation

/// CI simulator run (`-PTDebugNeuralProbe <voice key>`): downloads a neural voice, makes a sentence
/// with it on sherpa-onnx, and reports how it went in NSLog lines that start with "PTNeuralProbe"
/// ("PTNeuralProbe ok" when there was speech). With `-PTDebugNeuralPlay 1` it also plays the
/// sentence through the audio engine. Debug builds only.
enum NeuralProbe {
    @MainActor
    static func run(key: String, play: Bool) async {
        let store = NeuralVoiceStore.shared
        NSLog("PTNeuralProbe catalogue=%d voices", store.catalog.voices.count)
        guard let voice = store.catalog.voice(withKey: key) else {
            NSLog("PTNeuralProbe failed: there is no voice %@ in the catalogue", key)
            return
        }
        NSLog("PTNeuralProbe espeakData=%@", Bundle.main.url(forResource: "espeak-ng-data", withExtension: nil)?.path ?? "MISSING")

        let began = Date()
        if !store.isInstalled(voice) {
            store.install(voice)
            var lastReport = Date.distantPast
            while store.isBusy(voice) {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Date().timeIntervalSince(lastReport) > 5, let transfer = store.progress[key] {
                    NSLog("PTNeuralProbe %@ %.0f%%", String(describing: transfer.phase), transfer.fraction * 100)
                    lastReport = Date()
                }
                if Date().timeIntervalSince(began) > 300 { break }
            }
        }
        guard store.isInstalled(voice), let entry = store.index.entry(forID: voice.id) else {
            NSLog("PTNeuralProbe failed: %@ is not installed (%@)", key, store.failures[key] ?? "no reason given")
            return
        }
        NSLog("PTNeuralProbe installed %@ in %.1fs; the index lists %d", key, Date().timeIntervalSince(began), store.index.all.count)

        do {
            var audio: NeuralSynth.Audio?
            for pass in 1...2 {
                let started = Date()
                let made = try await NeuralSynth.shared.generate(text: SpeechPreview.sample(for: voice.language), directory: entry.directory, info: entry.info)
                let took = Date().timeIntervalSince(started)
                let seconds = Double(made.samples.count) / made.sampleRate
                let rms = (made.samples.reduce(0.0) { $0 + Double($1 * $1) } / Double(max(made.samples.count, 1))).squareRoot()
                let peak = made.samples.map { abs($0) }.max() ?? 0
                NSLog("PTNeuralProbe pass %d: %.2fs of audio at %.0f Hz, rms %.3f, peak %.3f, made in %.2fs", pass, seconds, made.sampleRate, rms, Double(peak), took)
                audio = made
            }
            guard let audio else { return }
            let seconds = Double(audio.samples.count) / audio.sampleRate
            let rms = (audio.samples.reduce(0.0) { $0 + Double($1 * $1) } / Double(max(audio.samples.count, 1))).squareRoot()
            if rms > 0.01 && seconds > 1.5 && seconds < 15 {
                NSLog("PTNeuralProbe ok")
            } else {
                NSLog("PTNeuralProbe failed: the audio doesn't look like speech")
            }
            if play {
                let played = await NeuralPlayer.shared.play(audio.samples, sampleRate: audio.sampleRate)
                NSLog("PTNeuralProbe played=%@", played ? "true" : "false")
            }
        } catch {
            NSLog("PTNeuralProbe failed: %@", error.localizedDescription)
        }
    }
}
#endif
