import Foundation

/// What "voice boost" and "trim silence" do to the audio, without any audio framework in it so it can be
/// checked off-device. Fed the samples of each block as they pass; it changes them in place (boost) and keeps
/// track of whether the sound has been quiet for a moment (trim — the player speeds up through it).
struct VoiceDSP {
    var boost = false
    var trim = false
    var sampleRate = 44_100.0

    /// The gain the last block was brought to.
    private(set) var gain: Float = 1
    private var silentFrames = 0
    /// The sound has been quiet for `silenceSeconds` or more.
    private(set) var inSilence = false

    /// Below this RMS a block counts as quiet (about −46 dB).
    static let silenceLevel: Float = 0.005
    static let silenceSeconds = 0.25
    /// Compression: above this RMS the level is squeezed 3:1, then everything is lifted.
    static let threshold: Float = 0.05
    static let ratio: Float = 3
    static let makeup: Float = 2.2
    /// Never boost anything quieter than this (room tone, hiss).
    static let floor: Float = 0.004

    /// One block: each plane is a run of samples (a channel each when the audio is planar, one run when it is
    /// interleaved). `frames` is how many sample frames the block holds.
    mutating func process(_ planes: [UnsafeMutableBufferPointer<Float>], frames: Int) {
        guard frames > 0 else { return }
        var sumSquares: Float = 0
        var count = 0
        for plane in planes {
            for sample in plane { sumSquares += sample * sample }
            count += plane.count
        }
        guard count > 0 else { return }
        let level = (sumSquares / Float(count)).squareRoot()

        // quiet for long enough?
        if level < Self.silenceLevel {
            silentFrames += frames
        } else {
            silentFrames = 0
        }
        inSilence = trim && Double(silentFrames) >= sampleRate * Self.silenceSeconds

        guard boost else { gain = 1; return }
        var target: Float = 1
        if level > Self.floor {
            let squeezed = level > Self.threshold ? Self.threshold + (level - Self.threshold) / Self.ratio : level
            target = min(max(squeezed * Self.makeup / level, 0.5), 4)
        }
        // glide to the new gain across the block, so it never steps
        let start = gain
        let end = start + (target - start) * 0.35
        let step = (end - start) / Float(frames)
        for plane in planes {
            // the frames of one plane (interleaved audio has several channels in a run: ramp by frame)
            let perFrame = max(plane.count / frames, 1)
            for i in 0 ..< plane.count {
                let g = start + step * Float(i / perFrame)
                plane[i] = Self.soften(plane[i] * g)
            }
        }
        gain = end
    }

    /// Past 0.8 the signal bends towards 1 instead of clipping.
    static func soften(_ x: Float) -> Float {
        let a = abs(x)
        guard a > 0.8 else { return x }
        let bent = 0.8 + 0.2 * tanhf((a - 0.8) / 0.2)
        return x < 0 ? -bent : bent
    }
}
