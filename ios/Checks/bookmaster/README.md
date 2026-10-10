# BookMaster contract check

Compiles the app's **real** BookMaster Swift sources (`ios/Pageturner/BookMaster/*`
and the `Book` model) on Linux or macOS, and drives them against a live local
BookMaster — so a change to either side that breaks the wire shows up here,
not on a phone.

```
Swift client  ->  Pageturner Pages Function (:8789)  ->  BookMaster (:8788)  ->  local D1
```

It checks, with the database as the judge: linking and one-time codes; progress,
sessions, quotes and presence; suggestions and comments (including sealed notes);
stats; shelf matching; recovery from a dead shelf pin; and the offline queue —
BookMaster is stopped mid-run, three pushes are parked in order, BookMaster comes
back, and they arrive in order with the newest position winning. A second block
(no servers needed) covers dates, old library files, authors and title matching.

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

SwiftUI, `ASWebAuthenticationSession` and the sign-in sheet closing on a real
device — those need an iPhone. The link hop through `docs/js/native-link.js` was
checked once in headless Chromium (see the commit that added it).
