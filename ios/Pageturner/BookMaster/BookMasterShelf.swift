import Foundation

/// One row of the reader's BookMaster shelf, slimmed for matching.
struct BMShelfRow: Decodable {
    var userBookId: String
    var bookId: String
    var title: String
    var author: String?
    var status: String
    var rating: Int?
    var upNext: Int?
    var percent: Double?
}

private struct BMShelfReply: Decodable { var books: [BMShelfRow] }

/// Which shelf row a local book is — the ladder the push side runs, mirrored
/// from `docs/js/bm-pull.js`: the pin, then a folded title + author match.
enum BMShelf {
    private static func fold(_ s: String) -> String {
        s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func stripBrackets(_ s: String) -> String {
        var out = s
        for (open, close) in [("(", ")"), ("[", "]")] as [(Character, Character)] {
            while let a = out.firstIndex(of: open), let b = out[a...].firstIndex(of: close) {
                out.replaceSubrange(a...b, with: " ")
            }
        }
        return out
    }

    /// The shapes a file's title can take: itself, the series note stripped
    /// ("Dune (Dune Chronicles, #1)" files as "Dune"), and the part ahead of a
    /// subtitle marker.
    static func titleForms(_ s: String) -> Set<String> {
        var forms: Set<String> = [fold(s), fold(stripBrackets(s))]
        func head(_ t: String) -> String {
            var h = t
            for marker in [" — ", " – ", ": ", " - "] {
                if let r = h.range(of: marker) { h = String(h[..<r.lowerBound]) }
            }
            return h
        }
        forms.insert(fold(head(s)))
        forms.insert(fold(head(stripBrackets(s))))
        forms.remove("")
        return forms
    }

    static func titlesAgree(_ want: String, _ got: String) -> Bool {
        let ws = titleForms(want)
        return titleForms(got).contains { g in
            ws.contains { w in
                w == g
                    || (w.count >= 8 && g.hasPrefix(w + " "))
                    || (g.count >= 8 && w.hasPrefix(g + " "))
            }
        }
    }

    /// First initial + surname, so "Herbert, Frank" and "Frank Herbert (Author)" agree.
    private static func nameKey(_ s: String) -> String? {
        let parts = fold(stripBrackets(s)).split(separator: " ").map(String.init)
        guard let first = parts.first, let last = parts.last else { return nil }
        return "\(first.prefix(1)) \(last)"
    }

    static func authorsAgree(_ want: String, _ got: String?) -> Bool {
        guard !want.isEmpty, let got, !got.isEmpty else { return true } // a missing author never decides
        let gotKeys = Set(
            got.replacingOccurrences(of: " and ", with: ";")
                .replacingOccurrences(of: "&", with: ";")
                .split(separator: ";").compactMap { nameKey(String($0)) })
        let wanted = sendableAuthor(want)
        return gotKeys.contains(nameKey(wanted) ?? "") || gotKeys.contains(nameKey(want) ?? "")
    }

    static func match(_ book: Book, in rows: [BMShelfRow]) -> BMShelfRow? {
        if let pin = book.bookmasterId, let hit = rows.first(where: { $0.userBookId == pin }) {
            return hit
        }
        return rows.first { titlesAgree(book.title, $0.title) && authorsAgree(book.author, $0.author) }
    }
}

extension BookMaster {
    /// Decorate the library with what the shelf knows. Pageturner's own
    /// position stays the local truth — a remote percent is shown, never imposed.
    func pullShelf(into library: LibraryStore) async {
        guard let user else { return }
        guard let (data, status) = try? await get("library", query: ["username": user.username]),
              (200..<300).contains(status),
              let reply = try? JSONDecoder().decode(BMShelfReply.self, from: data)
        else { return }
        var changes: [(UUID, (inout Book) -> Void)] = []
        for book in library.books {
            guard let row = BMShelf.match(book, in: reply.books) else { continue }
            let shelf = (id: row.userBookId, status: row.status, rating: row.rating,
                         percent: row.percent, upNext: row.upNext != nil)
            changes.append((book.id, { b in
                // the matched row wins: a stale pin (deleted there, or left by
                // another reader) is replaced, a good one comes back unchanged
                b.bookmasterId = shelf.id
                b.bmStatus = shelf.status
                b.bmRating = shelf.rating
                b.bmRemotePercent = shelf.percent
                b.bmUpNext = shelf.upNext
            }))
        }
        library.applyShelf(changes)
    }
}
