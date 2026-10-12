import Foundation

/// One chapter of an audiobook, positioned on the whole book's timeline.
struct AudioChapter: Identifiable, Hashable {
    /// Index into the book's chapter list.
    let id: Int
    var title: String
    /// Seconds from the start of the book.
    var start: TimeInterval
    var end: TimeInterval

    var length: TimeInterval { max(end - start, 0) }
}

/// Building and searching a chapter list. Pure logic — no AVFoundation — so the
/// ordering and clean-up rules can be checked off-device.
enum AudioChapters {
    /// How far to step back when playing again after `pausedFor` seconds: a long break loses the thread, a
    /// short one does not. A few seconds of the last sentence is enough to pick it up again.
    static func smartRewind(pausedFor seconds: TimeInterval) -> TimeInterval {
        guard seconds.isFinite, seconds >= 10 else { return 0 }
        switch seconds {
        case ..<60: return 2
        case ..<600: return 5
        case ..<3600: return 10
        default: return 20
        }
    }

    /// A multi-file audiobook is one chapter per file.
    static func fromTracks(titles: [String], offsets: [TimeInterval], duration: TimeInterval) -> [AudioChapter] {
        guard !offsets.isEmpty else { return [] }
        let raw: [(title: String, start: TimeInterval, end: TimeInterval?)] = offsets.enumerated().map { i, start in
            (i < titles.count ? titles[i] : "", start, i + 1 < offsets.count ? offsets[i + 1] : duration)
        }
        return normalise(raw, duration: duration)
    }

    /// Chapter markers as a file reports them (any order, maybe overlapping,
    /// maybe untitled, maybe past the end) → a clean list: sorted, clamped to
    /// the book, no zero-length or duplicate starts, every chapter running to the
    /// next one's start, untitled ones called "Chapter N".
    static func normalise(
        _ raw: [(title: String, start: TimeInterval, end: TimeInterval?)],
        duration: TimeInterval
    ) -> [AudioChapter] {
        let limit = duration > 0 ? duration : .greatestFiniteMagnitude
        let sorted = raw
            .filter { $0.start.isFinite && $0.start >= 0 && $0.start < limit }
            .sorted { $0.start < $1.start }

        var starts: [(title: String, start: TimeInterval, end: TimeInterval?)] = []
        for marker in sorted {
            // two markers on the same instant: keep the first (a duplicate, not a chapter)
            if let last = starts.last, marker.start - last.start < 0.5 { continue }
            starts.append(marker)
        }

        // Audio before the first marker (credits, a lead-in) is not part of chapter 1: give it a
        // chapter of its own, so "previous" and "next" from there go where they should
        let hasLeadIn = (starts.first?.start ?? 0) >= leadIn
        if hasLeadIn, let first = starts.first {
            starts.insert((title: "Opening", start: 0, end: first.start), at: 0)
        }

        var chapters: [AudioChapter] = []
        for (i, marker) in starts.enumerated() {
            let nextStart = i + 1 < starts.count ? starts[i + 1].start : nil
            var end = nextStart ?? marker.end ?? duration
            if !end.isFinite || end <= marker.start { end = nextStart ?? duration }
            if duration > 0 { end = min(end, duration) }
            guard end > marker.start else { continue }
            let title = marker.title.trimmingCharacters(in: .whitespacesAndNewlines)
            chapters.append(AudioChapter(
                id: chapters.count,
                // numbered from the first real chapter, not from the lead-in
                title: title.isEmpty ? "Chapter \(chapters.count + 1 - (hasLeadIn ? 1 : 0))" : title,
                start: marker.start, end: end))
        }
        return chapters
    }

    /// Audio this long before the first marker gets a chapter of its own.
    static let leadIn: TimeInterval = 1

    /// Positions are quantised when they are sought to (1/600 s) and read back from a clock: a
    /// position this close before a chapter's start is at its start.
    static let tolerance: TimeInterval = 0.05

    /// The chapter containing `position`: the last one that has started. A
    /// position before the first chapter belongs to the first.
    static func index(at position: TimeInterval, in chapters: [AudioChapter]) -> Int? {
        guard !chapters.isEmpty else { return nil }
        var low = 0, high = chapters.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if chapters[mid].start <= position + tolerance { low = mid } else { high = mid - 1 }
        }
        return low
    }

    /// What "previous chapter" means: restart this one unless you are already
    /// at its head (within `grace` seconds), when it goes back one.
    static func previousTarget(position: TimeInterval, in chapters: [AudioChapter], grace: TimeInterval = 3) -> Int? {
        guard let current = index(at: position, in: chapters) else { return nil }
        if position - chapters[current].start > grace { return current }
        return current > 0 ? current - 1 : current
    }
}

extension AudioChapters {
    /// Which file of a multi-file book holds the global time `t`: the last one that has started —
    /// so the very end of the book is the end of the last file.
    static func trackIndex(at t: TimeInterval, offsets: [TimeInterval]) -> Int? {
        guard !offsets.isEmpty else { return nil }
        var found = 0
        for (i, offset) in offsets.enumerated() where t >= offset - tolerance { found = i }
        return found
    }
}
