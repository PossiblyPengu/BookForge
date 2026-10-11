#!/bin/bash
# Run the Debug build in the iOS Simulator and photograph every screen.
#   simulator-shots.sh <udid> <path to Pageturner.app> <output dir>
# Each screen is a launch of the app with -PTDebugScreen (see Debug/DebugScenario.swift,
# compiled in Debug builds only). Also the first time the app is executed anywhere, so
# it reports whether it stayed alive and collects crash reports and the app's log.
set -u
UDID=$1; APP=$2; OUT=$3
BUNDLE=io.github.possiblypengu.pageturner
mkdir -p "$OUT/logs"
FAILED=0

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 2>/dev/null || true
xcrun simctl ui "$UDID" appearance light 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || { echo "::error::install failed"; exit 1; }

alive() {
  # launchctl lists the app as "<pid> <status> UIKitApplication:<bundle>[…]" while it runs
  local pid
  pid=$(xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep "UIKitApplication:$BUNDLE" | awk '{print $1}' | head -1)
  [[ "$pid" =~ ^[0-9]+$ ]]
}

# shot <name> <seconds to wait> [launch args…]
shot() {
  local name=$1 wait=$2; shift 2
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  local started; started=$(date +%s)
  xcrun simctl launch "$UDID" "$BUNDLE" "$@" >/dev/null 2>&1 || { echo "::warning::launch failed for $name"; FAILED=1; }
  sleep "$wait"
  if alive; then
    xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null 2>&1 || echo "::warning::no screenshot for $name"
    echo "ok     $name"
  else
    echo "::error::the app is not running after launching $name"
    FAILED=1
    xcrun simctl io "$UDID" screenshot "$OUT/$name-DEAD.png" >/dev/null 2>&1 || true
  fi
  xcrun simctl spawn "$UDID" log show --style compact --last "$(( $(date +%s) - started + 5 ))s" \
    --predicate 'process == "Pageturner"' 2>/dev/null | tail -n 150 > "$OUT/logs/$name.txt" || true
}

# first launch: an empty library
shot 01-empty 6

# seeded library (the first launch with -PTDebugSeed fills it; later launches reuse it)
shot 02-library 16 -PTDebugSeed 1 -PTDebugScreen library
shot 03-detail 6 -PTDebugScreen detail
shot 04-edit 6 -PTDebugScreen edit
shot 05-shelves 6 -PTDebugScreen shelves
shot 06-stats 6 -PTDebugScreen stats
shot 07-together 6 -PTDebugScreen together
shot 08-search 6 -PTDebugScreen search
shot 09-settings 6 -PTDebugScreen settings
shot 10-player 8 -PTDebugScreen player
shot 10b-player-chapters 12 -PTDebugScreen player -PTDebugPlayerSheet chapters
shot 11-reader 14 -PTDebugScreen reader -PTDebugKeepChrome 1
shot 12-reader-contents 14 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet contents
shot 13-reader-settings 14 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet settings
shot 14-reader-search 14 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet search
# no flag: the controls step aside on their own a few seconds after the book opens
shot 15-reader-autohide 14 -PTDebugScreen reader
shot 16-reader-jump 18 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet jump
shot 17-reader-footnote 14 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet footnote
shot 18-reader-highlight 14 -PTDebugScreen reader -PTDebugKeepChrome 1 -PTDebugReaderSheet highlight
shot 19-resume-prompt 8 -PTDebugScreen resume
shot 19b-library-select 10 -PTDebugScreen library -PTDebugLibraryMode select

# dark
xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true
shot 20-dark-library 8 -PTDebugScreen library
shot 21-dark-stats 6 -PTDebugScreen stats
shot 22-dark-player 8 -PTDebugScreen player
shot 23-dark-reader 14 -PTDebugScreen reader -PTDebugKeepChrome 1
shot 24-dark-settings 6 -PTDebugScreen settings
xcrun simctl ui "$UDID" appearance light 2>/dev/null || true

# large text
xcrun simctl ui "$UDID" content_size accessibility-extra-large 2>/dev/null || true
shot 30-large-library 8 -PTDebugScreen library
shot 31-large-stats 6 -PTDebugScreen stats
shot 32-large-settings 6 -PTDebugScreen settings
shot 33-large-player 8 -PTDebugScreen player
xcrun simctl ui "$UDID" content_size large 2>/dev/null || true

# crash reports from the host (the simulator writes them there)
mkdir -p "$OUT/crashes"
find ~/Library/Logs/DiagnosticReports -name 'Pageturner*' -newer "$APP" -exec cp {} "$OUT/crashes/" \; 2>/dev/null || true
if ls "$OUT/crashes"/* >/dev/null 2>&1; then echo "::error::crash reports found"; FAILED=1; fi

xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
exit $FAILED
