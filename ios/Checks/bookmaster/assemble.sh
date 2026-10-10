#!/bin/sh
# Copy the app's real BookMaster sources into the check's target, with the few
# changes Linux needs. Run again after changing anything under ios/Pageturner/BookMaster.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../../Pageturner"
OUT="$HERE/Sources/bmcheck"
cp "$SRC/BookMaster/BookMasterModels.swift" "$OUT/BookMasterModels.swift"
cp "$SRC/BookMaster/BookMasterShelf.swift" "$OUT/BookMasterShelf.swift"
python3 - "$SRC" "$OUT" <<'PY'
import sys
src, out = sys.argv[1], sys.argv[2]
s = open(f"{src}/BookMaster/BookMasterClient.swift").read()
# Linux keeps URLSession in FoundationNetworking; the bridge address comes from the environment
s = s.replace("import Foundation\nimport Observation", "import Foundation\n#if canImport(FoundationNetworking)\nimport FoundationNetworking\n#endif\nimport Observation", 1)
s = s.replace('static let bridge = URL(string: "https://pageturner.pages.dev/api/bookmaster")!',
              'static let bridge = URL(string: ProcessInfo.processInfo.environment["BM_BRIDGE"] ?? "https://pageturner.pages.dev/api/bookmaster")!', 1)
open(f"{out}/BookMasterClient.swift", "w").write(s)
# the real Book / Bookmark / Highlight types, without the app-only imports
t = open(f"{src}/Library/LibraryStore.swift").read()
body = "\n".join(l for l in t[:t.index("/// The library: book files")].split("\n") if not l.startswith("import "))
open(f"{out}/BookModel.swift", "w").write("import Foundation\n" + body)
PY
cat > "$OUT/LibraryStub.swift" <<'SW'
import Foundation
/// Just enough of LibraryStore for the shelf pull: the same applyShelf semantics.
@MainActor final class LibraryStore {
    var books: [Book] = []
    func applyShelf(_ changes: [(UUID, (inout Book) -> Void)]) {
        for (id, change) in changes {
            guard let i = books.firstIndex(where: { $0.id == id }) else { continue }
            var b = books[i]; change(&b); if b != books[i] { books[i] = b }
        }
    }
}
SW
echo "assembled into $OUT"
