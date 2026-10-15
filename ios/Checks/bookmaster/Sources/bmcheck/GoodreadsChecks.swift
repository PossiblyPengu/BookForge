import Foundation

/// The Goodreads export parser, checked against the cases BookMaster's own
/// csv.test.ts pins down — same column names, same shelf map, same guard and
/// date rules. (Covers and genres are the bridge's job: the import route
/// derives them server-side, so the rows carry neither.)
func runGoodreadsChecks() {
    section("Goodreads CSV: splitting")
    let plain = GoodreadsCSV.rows("a,b,c\n1,2,3")
    check("plain rows split", plain == [["a", "b", "c"], ["1", "2", "3"]])
    check("commas inside quotes keep",
          GoodreadsCSV.rows("title,author\n\"Hitchhiker's Guide, The\",Adams")
              == [["title", "author"], ["Hitchhiker's Guide, The", "Adams"]])
    check("doubled quotes unescape",
          GoodreadsCSV.rows("review\n\"She said \"\"hello\"\" twice\"")
              == [["review"], ["She said \"hello\" twice"]])
    check("newlines inside quotes keep",
          GoodreadsCSV.rows("review\n\"line one\nline two\"")
              == [["review"], ["line one\nline two"]])
    check("CRLF is one break",
          GoodreadsCSV.rows("a,b\r\n1,2") == [["a", "b"], ["1", "2"]])
    check("a UTF-8 BOM strips off the first header",
          GoodreadsCSV.rows("\u{feff}Book Id,Title").first == ["Book Id", "Title"])
    check("empty cells are preserved",
          GoodreadsCSV.rows("a,b,c\n1,,3") == [["a", "b", "c"], ["1", "", "3"]])
    check("blank lines between records are ignored",
          GoodreadsCSV.rows("a\n1\n\n2") == [["a"], ["1"], ["2"]])

    section("Goodreads CSV: rows")
    let header = "Book Id,Title,Author,Author l-f,ISBN,ISBN13,My Rating," +
        "Number of Pages,Year Published,Original Publication Year,Date Read," +
        "Date Added,Bookshelves,Exclusive Shelf,My Review,Read Count"
    func row(_ cells: [String: String]) -> String {
        header.split(separator: ",").map { cells[String($0)] ?? "" }.joined(separator: ",")
    }
    func parse(_ cells: [[String: String]], header: String = header) -> GoodreadsCSV.Report {
        GoodreadsCSV.parse(([header] + cells.map(row)).joined(separator: "\n"))
    }

    let done = parse([[
        "Book Id": "375802", "Title": "Ender’s Game", "Author": "Orson Scott Card",
        "ISBN13": "=\"9780812550702\"", "My Rating": "5", "Number of Pages": "324",
        "Original Publication Year": "1985", "Date Read": "2024/03/15",
        "Date Added": "2024/03/01", "Exclusive Shelf": "read",
    ]])
    let ender = done.books.first
    check("a finished book maps whole",
          done.skipped.isEmpty && done.books.count == 1
            && ender?.goodreadsId == "375802" && ender?.title == "Ender’s Game"
            && ender?.author == "Orson Scott Card" && ender?.isbn == "9780812550702"
            && ender?.totalPages == 324 && ender?.publishedYear == 1985
            && ender?.status == "read" && ender?.rating == 5
            && ender?.finishDate == "2024-03-15" && ender?.startDate == "2024-03-01",
          "\(String(describing: ender))")

    let shelves = parse([["Title": "A", "Author": "X", "Exclusive Shelf": "read"],
                         ["Title": "B", "Author": "X", "Exclusive Shelf": "currently-reading"],
                         ["Title": "C", "Author": "X", "Exclusive Shelf": "to-read"],
                         ["Title": "D", "Author": "X", "Exclusive Shelf": "something-custom"]])
    check("each shelf maps to a status",
          shelves.books.map(\.status) == ["read", "reading", "want_to_read", "want_to_read"],
          "\(shelves.books.map(\.status))")
    check("a did-not-finish shelf abandons",
          parse([["Title": "A", "Author": "X", "Exclusive Shelf": "did-not-finish"]])
              .books.first?.status == "abandoned")

    check("rating 0 is unrated, not one star",
          parse([["Title": "A", "Author": "X", "My Rating": "0", "Exclusive Shelf": "read"]])
              .books.first?.rating == nil)
    check("an unfinished book gets no finish date",
          parse([["Title": "A", "Author": "X", "Date Read": "2024/01/01", "Exclusive Shelf": "to-read"]])
              .books.first?.finishDate == nil)
    check("a reading book takes its added date as a start",
          parse([["Title": "A", "Author": "X", "Date Added": "2024/02/02", "Exclusive Shelf": "currently-reading"]])
              .books.first?.startDate == "2024-02-02")

    let gap = parse([["Title": "The  Library at Mount Char", "Author": "Scott  Hawkins",
                      "My Review": "Loved  it"]])
    check("doubled spaces in names squash, the review is the reader's own",
          gap.books.first?.title == "The Library at Mount Char"
            && gap.books.first?.author == "Scott Hawkins"
            && gap.books.first?.review == "Loved  it")

    let skipped = parse([["Title": "", "Author": "X", "Exclusive Shelf": "read"],
                         ["Title": "Good", "Author": "X", "Exclusive Shelf": "read"]])
    check("a row missing a title is skipped and reported",
          skipped.books.count == 1 && skipped.skipped.first?.row == 2
            && skipped.skipped.first?.reason == "Missing title or author")
    let notGR = GoodreadsCSV.parse("name,email\nAda,ada@example.com")
    check("a non-Goodreads file is refused",
          notGR.books.isEmpty && notGR.skipped.first?.reason.contains("Not a Goodreads") == true)
    check("columns are found by name, not position",
          GoodreadsCSV.parse("Author,Title,Exclusive Shelf\nLe Guin,The Dispossessed,read")
              .books.first?.title == "The Dispossessed")
    check("an empty file imports nothing", GoodreadsCSV.parse("").books.isEmpty)

    check("a Read Count of 3 carries through",
          parse([["Title": "A", "Author": "X", "Exclusive Shelf": "read", "Read Count": "3"]])
              .books.first?.readCount == 3)
    check("a finished book without a count reads once",
          parse([["Title": "A", "Author": "X", "Exclusive Shelf": "read", "Read Count": "0"]])
              .books.first?.readCount == 1)
    check("unfinished books count zero",
          parse([["Title": "A", "Author": "X", "Exclusive Shelf": "to-read"]])
              .books.first?.readCount == 0)
    check("ISBN-10 fills in when ISBN13 is missing",
          parse([["Title": "A", "Author": "X", "ISBN": "=\"043902348X\""]])
              .books.first?.isbn == "043902348X")

    section("Goodreads CSV: encoding for the bridge")
    // The rows encode as the import route's field names — snake_case all down.
    if let row = done.books.first,
       let data = try? JSONEncoder().encode(row),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        check("snake_case fields land",
              json["goodreads_id"] as? String == "375802"
                && json["total_pages"] as? Int == 324
                && json["published_year"] as? Int == 1985
                && json["start_date"] as? String == "2024-03-01"
                && json["finish_date"] as? String == "2024-03-15"
                && json["read_count"] as? Int == 1,
              "\(json.keys.sorted())")
        check("absent fields stay absent, not null",
              json["review"] == nil && json["goodreads_id"] != nil)
    } else {
        check("import row encodes", false)
    }
}
