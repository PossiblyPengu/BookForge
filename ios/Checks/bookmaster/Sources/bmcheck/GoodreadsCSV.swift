import Foundation

/// A Goodreads "Export Library" CSV, read the way BookMaster's own importer
/// reads it — the same column names, the same shelf→status map, the same
/// rules for the spreadsheet-guard ISBN and a missing read count. The file is
/// parsed here on the phone and only the rows travel; the file itself never
/// leaves the device.
enum GoodreadsCSV {
    /// One row that could not be used, with the reason — surfaced to the user.
    struct Skipped: Equatable {
        let row: Int
        let reason: String
    }

    struct Report {
        var books: [BMImportRow]
        var skipped: [Skipped]
    }

    /// Split RFC 4180 text into rows of raw cells — quotes only open a quoted
    /// field at a field's start (which keeps `="0439023483"` intact), doubled
    /// quotes inside one are a literal, CRLF counts as one break, and blank
    /// lines between records are ignored. A UTF-8 BOM comes with the export.
    static func rows(_ input: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var cell = ""
        var inQuotes = false

        var text = input
        if text.hasPrefix("\u{feff}") { text.removeFirst() }
        // Scalars, not Characters — a CRLF counts as one grapheme in String's
        // view but is two terminators here, exactly as RFC 4180 means it.
        let chars = Array(text.unicodeScalars)

        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if inQuotes {
                if ch == "\"" {
                    if i + 1 < chars.count, chars[i + 1] == "\"" {
                        cell.unicodeScalars.append("\"")
                        i += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    cell.unicodeScalars.append(ch)
                }
                i += 1
                continue
            }
            if ch == "\"", cell.isEmpty {
                inQuotes = true
            } else if ch == "," {
                row.append(cell)
                cell = ""
            } else if ch == "\n" || ch == "\r" {
                if ch == "\r", i + 1 < chars.count, chars[i + 1] == "\n" { i += 1 }
                row.append(cell)
                cell = ""
                if row.count > 1 || row.first != "" { rows.append(row) }
                row = []
            } else {
                cell.unicodeScalars.append(ch)
            }
            i += 1
        }
        if !cell.isEmpty || !row.isEmpty {
            row.append(cell)
            if row.count > 1 || row.first != "" { rows.append(row) }
        }
        return rows
    }

    /// Map a Goodreads export into import rows. Columns are looked up by header
    /// name, not index — Goodreads has changed both the order and the set.
    static func parse(_ input: String) -> Report {
        let rows = rows(input)
        guard !rows.isEmpty else { return Report(books: [], skipped: []) }
        var skipped: [Skipped] = []
        var books: [BMImportRow] = []

        let header = rows[0].map { clean($0).lowercased() }
        func col(_ name: String) -> Int { header.firstIndex(of: name.lowercased()) ?? -1 }

        let idx = (
            id: col("Book Id"),
            title: col("Title"),
            author: col("Author"),
            isbn13: col("ISBN13"),
            isbn: col("ISBN"),
            rating: col("My Rating"),
            pages: col("Number of Pages"),
            year: col("Original Publication Year"),
            yearPublished: col("Year Published"),
            dateRead: col("Date Read"),
            dateAdded: col("Date Added"),
            shelf: col("Exclusive Shelf"),
            shelves: col("Bookshelves"),
            review: col("My Review"),
            readCount: col("Read Count"))

        guard idx.title != -1, idx.author != -1 else {
            skipped.append(Skipped(row: 1, reason: "Not a Goodreads export — missing Title/Author columns"))
            return Report(books: [], skipped: skipped)
        }

        func at(_ row: [String], _ i: Int) -> String {
            i >= 0 && i < row.count ? clean(row[i]) : ""
        }

        for r in 1..<rows.count {
            let row = rows[r]
            let title = squash(at(row, idx.title))
            let author = squash(at(row, idx.author))
            if title.isEmpty || author.isEmpty {
                skipped.append(Skipped(row: r + 1, reason: "Missing title or author"))
                continue
            }

            let status = shelfToStatus[at(row, idx.shelf).lowercased()] ?? "want_to_read"
            let rating = toInt(row, idx.rating)
            let parsedCount = toInt(row, idx.readCount) ?? 0
            // A finished book has been read at least once even when the export
            // reports no count, which older exports do.
            let readCount = status == "read" ? max(1, parsedCount) : parsedCount
            let finishDate = toDate(row, idx.dateRead)
            // No "date started" in an export — a finished or started book gets
            // its added-date so duration stats stay plausible rather than null.
            let addedDate = toDate(row, idx.dateAdded)
            let isbn = at(row, idx.isbn13).isEmpty ? at(row, idx.isbn) : at(row, idx.isbn13)

            books.append(BMImportRow(
                title: title,
                author: author.isEmpty ? nil : author,
                goodreadsId: at(row, idx.id).isEmpty ? nil : at(row, idx.id),
                isbn: isbn.isEmpty ? nil : isbn,
                totalPages: toInt(row, idx.pages),
                publishedYear: toInt(row, idx.year) ?? toInt(row, idx.yearPublished),
                status: status,
                // Goodreads writes 0 for "no rating"; keep that distinct from 1 star.
                rating: rating.flatMap { (1...5).contains($0) ? $0 : nil },
                review: at(row, idx.review).isEmpty ? nil : at(row, idx.review),
                startDate: (status == "read" || status == "reading") ? addedDate : nil,
                finishDate: status == "read" ? finishDate : nil,
                readCount: readCount))
        }
        return Report(books: books, skipped: skipped)
    }

    /// Goodreads' Exclusive Shelf column → BookMaster's status names.
    private static let shelfToStatus: [String: String] = [
        "read": "read",
        "currently-reading": "reading",
        "to-read": "want_to_read",
        "abandoned": "abandoned",
        "did-not-finish": "abandoned",
        "dnf": "abandoned",
    ]

    /// Unwrap the `="..."` spreadsheet guard (it stops Excel dropping an ISBN's
    /// leading zeros) and normalise blanks; both `="123"` and `=123` arrive.
    private static func clean(_ value: String) -> String {
        var t = value.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("=") {
            t.removeFirst()
            if t.hasPrefix("\""), t.hasSuffix("\""), t.count >= 2 {
                t = String(t.dropFirst().dropLast())
            }
        }
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// A run of literal spaces is never intentional in a name or a title.
    private static func squash(_ s: String) -> String {
        s.replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression)
    }

    private static func toInt(_ row: [String], _ i: Int) -> Int? {
        guard i >= 0, i < row.count else { return nil }
        let c = clean(row[i]).replacingOccurrences(of: ",", with: "")
        guard !c.isEmpty, let n = Int(c), n > 0 else { return nil }
        return n
    }

    /// Goodreads dates are `YYYY/MM/DD`; normalise to ISO `YYYY-MM-DD`.
    private static func toDate(_ row: [String], _ i: Int) -> String? {
        guard i >= 0, i < row.count else { return nil }
        let c = clean(row[i])
        guard let m = c.range(of: #"^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$"#, options: .regularExpression) else { return nil }
        let parts = c[m].split(whereSeparator: { $0 == "/" || $0 == "-" })
        guard parts.count == 3 else { return nil }
        let month = parts[1].count == 1 ? "0\(parts[1])" : String(parts[1])
        let day = parts[2].count == 1 ? "0\(parts[2])" : String(parts[2])
        return "\(parts[0])-\(month)-\(day)"
    }
}
