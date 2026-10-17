import Foundation

// Checks for the scheduled backup's planning: when one is due, what it is called, and which old copies go.

@MainActor
func runAutoBackupChecks() {
    section("Scheduled backup planning")
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    // Sat 17 Oct 2026, 03:30 UTC
    let now = Date(timeIntervalSince1970: 1_792_207_800)

    check("a backup is named by its day", AutoBackupPlan.fileName(for: now, calendar: cal) == "pageturner-backup-2026-10-17.zip",
          AutoBackupPlan.fileName(for: now, calendar: cal))
    check("…with the month and day padded",
          AutoBackupPlan.fileName(for: Date(timeIntervalSince1970: 1_767_225_600 + 5 * 86_400), calendar: cal) == "pageturner-backup-2026-01-06.zip")
    var west = cal
    west.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    check("…the day as the reader's calendar sees it (3:30 UTC is still the 16th in Los Angeles)",
          AutoBackupPlan.fileName(for: now, calendar: west) == "pageturner-backup-2026-10-16.zip")

    check("its own files are known, and nothing else in the folder",
          AutoBackupPlan.isBackupFile("pageturner-backup-2026-10-17.zip")
          && !AutoBackupPlan.isBackupFile("pageturner-backup-2026-10-17.zip.icloud")
          && !AutoBackupPlan.isBackupFile("pageturner-backup-2026-1-17.zip")
          && !AutoBackupPlan.isBackupFile("pageturner-backup-2026-10-1x.zip")
          && !AutoBackupPlan.isBackupFile("pageturner-backup-2026_10_17.zip")
          && !AutoBackupPlan.isBackupFile("holiday-photos.zip")
          && !AutoBackupPlan.isBackupFile("pageturner-backup-.zip")
          && !AutoBackupPlan.isBackupFile(""))

    let t = now.timeIntervalSince1970
    check("a library never backed up is due", AutoBackupPlan.isDue(last: 0, now: now, interval: .weekly))
    check("not due inside the interval", !AutoBackupPlan.isDue(last: t - 3 * 86_400, now: now, interval: .weekly))
    check("due once the interval is up", AutoBackupPlan.isDue(last: t - 7 * 86_400, now: now, interval: .weekly)
          && AutoBackupPlan.isDue(last: t - 40 * 86_400, now: now, interval: .monthly))
    check("an hour early still counts (a run a little ahead of its day)", AutoBackupPlan.isDue(last: t - 7 * 86_400 + 1_800, now: now, interval: .weekly)
          && !AutoBackupPlan.isDue(last: t - 7 * 86_400 + 7_200, now: now, interval: .weekly))
    check("daily is a day, monthly thirty", AutoBackupPlan.Interval.daily.seconds == 86_400 && AutoBackupPlan.Interval.monthly.seconds == 30 * 86_400)

    check("the next run is an interval after the last, or now when overdue",
          AutoBackupPlan.nextRun(last: t - 86_400, now: now, interval: .weekly) == Date(timeIntervalSince1970: t + 6 * 86_400)
          && AutoBackupPlan.nextRun(last: t - 30 * 86_400, now: now, interval: .weekly) == now
          && AutoBackupPlan.nextRun(last: 0, now: now, interval: .weekly) == now)

    let names = ["pageturner-backup-2026-10-03.zip", "notes.txt", "pageturner-backup-2026-10-17.zip", "pageturner-backup-2026-09-26.zip",
                 "pageturner-backup-2026-10-10.zip", "holiday.zip"]
    check("only the oldest copies beyond the ones kept are cleared, oldest first",
          AutoBackupPlan.stale(names, keep: 2) == ["pageturner-backup-2026-09-26.zip", "pageturner-backup-2026-10-03.zip"],
          "\(AutoBackupPlan.stale(names, keep: 2))")
    check("keeping more than there are clears nothing", AutoBackupPlan.stale(names, keep: 9).isEmpty)
    check("at least one copy is always kept", AutoBackupPlan.stale(names, keep: 0).count == 3 && AutoBackupPlan.stale(names, keep: -4).count == 3)
    check("foreign files are never named for deletion", !AutoBackupPlan.stale(names, keep: 1).contains("notes.txt") && !AutoBackupPlan.stale(names, keep: 1).contains("holiday.zip"))
    check("an empty folder has nothing to clear", AutoBackupPlan.stale([], keep: 3).isEmpty)

    check("room for a backup needs a tenth and 50 MB over its size",
          AutoBackupPlan.hasRoom(needed: 1_000_000_000, free: 1_200_000_000)
          && !AutoBackupPlan.hasRoom(needed: 1_000_000_000, free: 1_100_000_000)
          && AutoBackupPlan.hasRoom(needed: 0, free: 60_000_000)
          && !AutoBackupPlan.hasRoom(needed: 0, free: 10_000_000))
}
