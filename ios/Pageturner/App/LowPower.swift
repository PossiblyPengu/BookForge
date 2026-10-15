import Foundation

/// iOS's Low Power Mode, named once. When it is on the app trades polish for
/// battery: the presence beat stretches, the neural voice's playhead ticker
/// slows, the curl's animated finishes throttle to 15fps, and the marks that
/// move for every spoken word stop being painted (the sentence still is).
enum LowPower {
    static var on: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }

    /// Posted when iOS toggles the mode while the app runs.
    static let changed = NSNotification.Name.NSProcessInfoPowerStateDidChange
}
