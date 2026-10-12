import Foundation

// Checks for the BookMaster shelf the app shows: which rows are not on this iPhone, how they group, and
// that a cached row still reads. No servers needed.

private func row(_ id: String, _ title: String, _ author: String?, _ status: String, upNext: Int? = nil,
                 format: String? = nil, isbn: String? = nil, ol: String? = nil) -> BMShelfRow {
    BMShelfRow(userBookId: id, bookId: "b" + id, title: title, author: author, status: status, rating: nil,
               upNext: upNext, percent: nil, format: format, totalPages: nil, openLibraryId: ol, isbn: isbn)
}

@MainActor
func runShelfChecks() {
    section("The BookMaster shelf inside the app")
    var dune = Book(id: UUID(), title: "Dune", author: "Frank Herbert", fileName: "d.epub", fileNames: ["d.epub"], addedAt: Date())
    var pinned = Book(id: UUID(), title: "A file called something else", author: "", fileName: "p.epub", fileNames: ["p.epub"], addedAt: Date())
    pinned.bookmasterId = "ub-pin"
    dune.bookmasterId = nil
    let rows = [
        row("ub-dune", "Dune (Dune Chronicles, #1)", "Frank Herbert", "reading"),
        row("ub-pin", "Hyperion", "Dan Simmons", "reading"),
        row("ub-emma", "Emma", "Jane Austen", "want_to_read", upNext: 2),
        row("ub-persuasion", "Persuasion", "Jane Austen", "want_to_read", upNext: 1),
        row("ub-mock", "Mockingjay", "Suzanne Collins", "read"),
        row("ub-odd", "Walden", "Thoreau", "dnf"),
    ]
    let missing = BMShelf.missing(from: rows, on: [dune, pinned])
    check("a shelf row is on this iPhone when a book matches it by title and author, or is pinned to it",
          Set(missing.map(\.userBookId)) == ["ub-emma", "ub-persuasion", "ub-mock", "ub-odd"], "\(missing.map(\.userBookId))")
    check("with no books on the iPhone every row is missing, and with every book there none", BMShelf.missing(from: rows, on: []).count == rows.count
          && BMShelf.missing(from: [], on: [dune]).isEmpty)

    let groups = BMShelf.groups(missing)
    check("groups run Up next, Reading, Want to read, Finished, Other — and empty ones are left out",
          groups.map(\.title) == ["Up next", "Finished", "Other"], "\(groups.map(\.title))")
    check("Up next keeps BookMaster's own order", groups.first?.rows.map(\.userBookId) == ["ub-persuasion", "ub-emma"])
    check("a row that is up next is not also listed under its status",
          !groups.contains { $0.title == "Want to read" })
    check("every row is in exactly one group", groups.flatMap(\.rows).count == missing.count)
    check("statuses read as people say them", BMShelf.label(forStatus: "want_to_read") == "Want to read"
          && BMShelf.label(forStatus: "dnf") == "Didn’t finish" && BMShelf.label(forStatus: "on_hold") == "On Hold")

    check("a jacket comes from the ISBN, else the Open Library id, else none",
          row("a", "T", nil, "read", isbn: "9780441172719").coverURL?.absoluteString.contains("/isbn/9780441172719-M.jpg") == true
          && row("b", "T", nil, "read", ol: "OL123M").coverURL?.absoluteString.contains("/olid/OL123M-M.jpg") == true
          && row("c", "T", nil, "read").coverURL == nil)

    // the shelf is cached as JSON: a row cached by an earlier build (without the newer fields) still reads
    let old = Data(#"[{"userBookId":"u","bookId":"b","title":"Old","status":"reading"}]"#.utf8)
    let decoded = try? JSONDecoder().decode([BMShelfRow].self, from: old)
    check("a cached row without the newer fields still reads", decoded?.first?.title == "Old" && decoded?.first?.format == nil)
    let round = (try? JSONEncoder().encode(rows)).flatMap { try? JSONDecoder().decode([BMShelfRow].self, from: $0) }
    check("the shelf round-trips through its cache", round == rows)
}
