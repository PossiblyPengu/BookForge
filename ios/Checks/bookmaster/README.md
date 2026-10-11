# BookMaster contract check, and the app's logic

Compiles the app's **real** BookMaster Swift sources (`ios/Pageturner/BookMaster/*`
and the `Book` model) on Linux or macOS, and drives them against a live local
BookMaster — so a change to either side that breaks the wire shows up here,
not on a phone. The same target also compiles and runs the app's UIKit-free logic —
`assemble.sh` lists the files — so rules that need no device get checked here:
the text→EPUB converter, ISBN and description cleaning, audiobook chapters, the
"continue from BookMaster?" offer, the notification plan, the Back history, highlight
export, reading stats and streaks, the voice list (grouping, order, search, which voice "Automatic"
prefers, the speed scale), the neural voice catalogue and the conversion of a Piper voice into what the on-device
engine loads, and the date round-trip of the catalogue.

```
Swift client  ->  Pageturner Pages Function (:8789)  ->  BookMaster (:8788)  ->  local D1
```

It checks, with the database as the judge: linking and one-time codes; progress,
sessions, quotes and presence; suggestions and comments (including sealed notes);
stats; shelf matching; recovery from a dead shelf pin; and the offline queue —
BookMaster is stopped mid-run, three pushes are parked in order, BookMaster comes
back, and they arrive in order with the newest position winning. A second block
(no servers needed, ~200 checks) covers dates, old library files, authors and title
matching, and the logic above.

## Run it

```bash
# a BookMaster checkout with `npm ci` done, and a Swift 6 toolchain on PATH
BOOKMASTER_REPO=/path/to/BookMaster ios/Checks/bookmaster/run.sh        # everything, ~3 minutes
ios/Checks/bookmaster/run.sh data                                       # just the checks that need no servers
```

`run.sh` assembles the sources, builds, resets a fresh stack (two accounts and a
one-time code), runs, and tears everything down — including the throwaway
`.dev.vars` it writes into the BookMaster checkout.

Re-run it after changing `ios/Pageturner/BookMaster/`, `functions/api/bookmaster/`,
or BookMaster's `functions/_lib/routes/pageturner.ts`.

## What it does not cover

SwiftUI, the in-app sign-in sheet and the audio engine on a real device — those need
an iPhone (the CI simulator run photographs the sheet and the voice lists, and makes real speech
with a downloaded neural voice).

To convert a real downloaded Piper voice with the app's code (and then load it with sherpa-onnx
to hear that it works), set `PIPER_RAW_ONNX`, `PIPER_RAW_JSON` and `PIPER_OUT_DIR` when running
the built `bmcheck` (`BM_ONLY=data .build/debug/bmcheck`).
