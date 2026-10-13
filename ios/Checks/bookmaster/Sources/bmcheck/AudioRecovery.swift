import Foundation

struct AudioRecovery {
    private(set) var canRecover = true

    mutating func beginInterruption() { canRecover = false }
    mutating func endInterruption(shouldResume: Bool) { canRecover = shouldResume }
    mutating func start() { canRecover = true }
    mutating func stop() { canRecover = false }
}
