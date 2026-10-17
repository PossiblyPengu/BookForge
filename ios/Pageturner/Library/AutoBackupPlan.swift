import Foundation

/// When a scheduled backup is due, what its file is called, and which old copies to clear away. Pure logic,
/// checked off-device (ios/Checks/bookmaster).
enum AutoBackupPlan {
    enum Interval: String, CaseIterable, Identifiable {
        case daily, weekly, monthly

        var id: String { rawValue }

        var label: String {
            switch self {
            case .daily: return "Every day"
            case .weekly: return "Every week"
            case .monthly: return "Every month"
            }
        }

        var seconds: TimeInterval {
            switch self {
            case .daily: return 86_400
            case .weekly: return 7 * 86_400
            case .monthly: return 30 * 86_400
            }
        }
    }

    static let filePrefix = "pageturner-backup-"
    static let fileSuffix = ".zip"

    /// "pageturner-backup-2026-10-17.zip", the date as `calendar` sees it. Named by day, so a second backup the same
    /// day replaces the first, and a folder's copies sort oldest to newest by name.
    static func fileName(for date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
        let year = c.year ?? 0
        let y = String(year).count >= 4 ? String(year) : String(repeating: "0", count: 4 - String(year).count) + String(year)
        return "\(filePrefix)\(y)-\(two(c.month ?? 0))-\(two(c.day ?? 0))\(fileSuffix)"
    }

    /// One of this app's own scheduled backups — and nothing else that happens to be in the folder.
    static func isBackupFile(_ name: String) -> Bool {
        guard name.hasPrefix(filePrefix), name.hasSuffix(fileSuffix) else { return false }
        let stamp = Array(name.dropFirst(filePrefix.count).dropLast(fileSuffix.count))
        guard stamp.count == 10 else { return false }
        return stamp.enumerated().allSatisfy { i, ch in
            i == 4 || i == 7 ? ch == "-" : ch.isASCII && ch.isNumber
        }
    }

    /// Whether another backup should be made. `last` is when the previous one finished (seconds since 1970, 0 for
    /// never). An hour of slack, so a run that lands a little early on its day is not put off a whole interval.
    static func isDue(last: Double, now: Date, interval: Interval) -> Bool {
        guard last > 0 else { return true }
        return now.timeIntervalSince1970 - last >= interval.seconds - 3_600
    }

    /// The earliest the next backup is wanted: an interval after the last, or now if it is already overdue.
    static func nextRun(last: Double, now: Date, interval: Interval) -> Date {
        guard last > 0 else { return now }
        return max(now, Date(timeIntervalSince1970: last + interval.seconds))
    }

    /// The copies to delete so only the newest `keep` remain (at least one), oldest first. Only this app's own
    /// backup files are ever named — anything else in the folder is left alone.
    static func stale(_ names: [String], keep: Int) -> [String] {
        let ours = names.filter(isBackupFile).sorted(by: >)   // newest first: the stamp sorts by date
        return Array(ours.dropFirst(max(keep, 1))).reversed()
    }

    /// Whether `free` bytes can hold a backup of `needed` bytes — with a tenth and 50 MB to spare, for the zip's
    /// own bookkeeping and for the system to carry on.
    static func hasRoom(needed: Int64, free: Int64) -> Bool {
        free >= needed + needed / 10 + 50_000_000
    }
}
