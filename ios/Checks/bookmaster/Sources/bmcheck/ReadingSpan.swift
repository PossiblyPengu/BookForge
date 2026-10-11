import Foundation

/// What of a reading sitting was actually read: the pages turned to, not the distance covered by
/// jumps. Jumping from 10% to 50% (the scrubber, a contents entry, a search hit) and closing the
/// book is not 40% read — BookMaster used to be told it was. Pure logic, checked on Linux.
struct ReadingSpan: Equatable {
    /// How much of the book, 0…1, was read this sitting.
    private(set) var span = 0.0
    private var last: Double?
    /// The next position is where a jump landed.
    private var landing = false
    /// The place was reached by a jump and not read on from yet.
    private(set) var reachedByJump = false

    /// A forward step bigger than this is a layout change or an unannounced jump, not a page turn.
    static let stepLimit = 0.2
    /// What BookMaster is told at most for a place that was only jumped to: not "finished".
    static let unreadCeiling = 0.99

    init(startingAt progression: Double? = nil) {
        last = progression
    }

    /// The navigator announced a jump: where it lands is not read.
    mutating func jumped() {
        landing = true
        reachedByJump = true
    }

    /// The reader's position changed.
    mutating func moved(to progression: Double?) {
        guard let progression, progression.isFinite else { return }
        defer { last = progression }
        if landing {
            landing = false
            return
        }
        if let last, progression > last, progression - last <= Self.stepLimit {
            span += progression - last
            reachedByJump = false
        }
    }

    /// A new sitting begins: the count starts again, from wherever the book is.
    mutating func restart(at progression: Double?) {
        span = 0
        if let progression { last = progression }
    }

    /// The place to tell BookMaster about. A last-page peek reached by a jump stays under "finished" —
    /// reading on to the end is what finishes a book (or marking it so).
    func reportable(_ progression: Double) -> Double {
        reachedByJump ? min(progression, Self.unreadCeiling) : progression
    }
}
