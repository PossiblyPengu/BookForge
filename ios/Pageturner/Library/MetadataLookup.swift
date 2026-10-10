import Foundation
import UIKit

/// One possible match from an online metadata source.
struct MetadataCandidate: Identifiable, Hashable {
    let id = UUID()
    var title: String
    var authors: String
    var year: String
    /// A blurb, when the source has one.
    var summary: String = ""
    var isbn: String?
    /// Open Library work id — what BookMaster keeps on its catalogue rows.
    var openLibraryId: String?
    var coverURL: URL?
    var source: String
    /// The BookMaster shelf row this is — applying it pins the book there, so a
    /// later push can never write a duplicate.
    var bookmasterId: String?
}

/// Book metadata lookup: BookMaster's own catalogue first when linked (its hits
/// carry shelf pins and catalogue ids), then Google Books and Open Library.
/// Only ever called on an explicit user action — the edit sheet's "Find Details"
/// or a bulk "Find details" on selected books — never in the background.
enum MetadataLookup {
    static func search(title: String, author: String) async -> [MetadataCandidate] {
        async let bm = bookMasterCandidates(title: title, author: author)
        async let gb = googleBooks(title: title, author: author)
        async let ol = openLibrary(title: title, author: author)
        let (b, g, o) = await (bm, gb, ol)
        return dedupe(b + g + o)
    }

    /// The same book from several sources collapses to one row — the first
    /// source's, with whatever it lacked (a blurb, an ISBN, a cover) filled in.
    static func dedupe(_ candidates: [MetadataCandidate]) -> [MetadataCandidate] {
        var index: [String: Int] = [:]
        var out: [MetadataCandidate] = []
        for c in candidates {
            let key = (c.title + "|" + c.authors)
                .lowercased()
                .filter { $0.isLetter || $0.isNumber }
            guard !key.isEmpty else { continue }
            if let i = index[key] {
                if out[i].summary.isEmpty { out[i].summary = c.summary }
                if out[i].isbn == nil { out[i].isbn = c.isbn }
                if out[i].openLibraryId == nil { out[i].openLibraryId = c.openLibraryId }
                if out[i].coverURL == nil { out[i].coverURL = c.coverURL }
                if out[i].year.isEmpty { out[i].year = c.year }
                continue
            }
            index[key] = out.count
            out.append(c)
        }
        return out
    }

    // MARK: - BookMaster

    private static func bookMasterCandidates(title: String, author: String) async -> [MetadataCandidate] {
        let hits = await BookMaster.shared.searchCatalogue(title: title, author: author)
        return hits.compactMap { hit in
            guard !hit.title.isEmpty else { return nil }
            return MetadataCandidate(
                title: hit.title,
                authors: hit.author ?? "",
                year: hit.year ?? "",
                isbn: hit.isbn.flatMap { ISBN.normalize($0) },
                openLibraryId: hit.openLibraryId,
                coverURL: hit.coverUrl.flatMap { URL(string: $0) },
                source: hit.userBookId != nil ? "On your BookMaster shelf" : "BookMaster",
                bookmasterId: hit.userBookId)
        }
    }

    // MARK: - Google Books

    private static func googleBooks(title: String, author: String) async -> [MetadataCandidate] {
        var q = "intitle:\(title)"
        if !author.isEmpty { q += " inauthor:\(author)" }
        guard var comp = URLComponents(string: "https://www.googleapis.com/books/v1/volumes") else { return [] }
        comp.queryItems = [
            URLQueryItem(name: "q", value: q),
            URLQueryItem(name: "maxResults", value: "8"),
            URLQueryItem(name: "fields", value: "items(volumeInfo(title,authors,publishedDate,imageLinks,description,industryIdentifiers))"),
        ]
        guard let url = comp.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["items"] as? [[String: Any]]
        else { return [] }

        return items.compactMap { item in
            guard let info = item["volumeInfo"] as? [String: Any],
                  let t = info["title"] as? String, !t.isEmpty
            else { return nil }
            let authors = (info["authors"] as? [String] ?? []).joined(separator: ", ")
            let year = String((info["publishedDate"] as? String ?? "").prefix(4))
            var cover: URL?
            if let links = info["imageLinks"] as? [String: Any],
               let thumb = (links["thumbnail"] as? String) ?? (links["smallThumbnail"] as? String)
            {
                // Google serves covers over http — force https for ATS
                cover = URL(string: thumb.replacingOccurrences(of: "http://", with: "https://"))
            }
            let identifiers = (info["industryIdentifiers"] as? [[String: Any]] ?? [])
                .compactMap { $0["identifier"] as? String }
            return MetadataCandidate(
                title: t, authors: authors, year: year,
                summary: BookText.plain(fromHTML: info["description"] as? String ?? ""),
                isbn: ISBN.best(of: identifiers), coverURL: cover, source: "Google Books")
        }
    }

    // MARK: - Open Library

    private static func openLibrary(title: String, author: String) async -> [MetadataCandidate] {
        guard var comp = URLComponents(string: "https://openlibrary.org/search.json") else { return [] }
        var items = [
            URLQueryItem(name: "title", value: title),
            URLQueryItem(name: "limit", value: "8"),
            URLQueryItem(name: "fields", value: "key,title,author_name,first_publish_year,cover_i,isbn"),
        ]
        if !author.isEmpty { items.append(URLQueryItem(name: "author", value: author)) }
        comp.queryItems = items
        guard let url = comp.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let docs = json["docs"] as? [[String: Any]]
        else { return [] }

        return docs.compactMap { doc in
            guard let t = doc["title"] as? String, !t.isEmpty else { return nil }
            let authors = (doc["author_name"] as? [String] ?? []).joined(separator: ", ")
            let year = (doc["first_publish_year"] as? Int).map(String.init) ?? ""
            var cover: URL?
            if let coverID = doc["cover_i"] as? Int {
                cover = URL(string: "https://covers.openlibrary.org/b/id/\(coverID)-M.jpg")
            }
            // "/works/OL45804W" → "OL45804W", the id BookMaster keeps
            let olid = (doc["key"] as? String).map { $0.replacingOccurrences(of: "/works/", with: "") }
            let isbns = (doc["isbn"] as? [String] ?? []).prefix(25).map { $0 }
            return MetadataCandidate(
                title: t, authors: authors, year: year, isbn: ISBN.best(of: Array(isbns)),
                openLibraryId: olid, coverURL: cover, source: "Open Library")
        }
    }

    // MARK: - Applying

    /// Download a candidate's cover into the covers folder for `book`.
    static func applyCover(from url: URL, to book: Book, library: LibraryStore) async {
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let image = UIImage(data: data),
              let jpeg = image.jpegData(compressionQuality: 0.85)
        else { return }
        await MainActor.run {
            try? jpeg.write(to: library.coverURL(for: book))
            library.coverChanged()
        }
    }

    /// Fill in what a book is missing from the first online match that really is
    /// the same book — used by bulk "Find details". Never overwrites something
    /// already there. Returns whether anything changed.
    @MainActor
    static func autoApply(to id: UUID, library: LibraryStore) async -> Bool {
        guard let book = library.books.first(where: { $0.id == id }) else { return false }
        let results = await search(title: book.title, author: book.author)
        guard let match = results.first(where: {
            BMShelf.titlesAgree(book.title, $0.title) && BMShelf.authorsAgree(book.author, $0.authors)
        }) else { return false }

        var updated = book
        if updated.author.isEmpty, !match.authors.isEmpty { updated.author = match.authors }
        if updated.year == nil, !match.year.isEmpty { updated.year = match.year }
        if updated.bookDescription == nil, !match.summary.isEmpty { updated.bookDescription = match.summary }
        if updated.isbn == nil { updated.isbn = match.isbn }
        if updated.openLibraryId == nil { updated.openLibraryId = match.openLibraryId }
        var changed = updated != book
        if changed { library.update(updated) }
        if let pin = match.bookmasterId, book.bookmasterId == nil {
            library.updateBookMaster(id) { $0.bookmasterId = pin }
            changed = true
        }
        if !FileManager.default.fileExists(atPath: library.coverURL(for: book).path), let url = match.coverURL {
            await applyCover(from: url, to: book, library: library)
            changed = true
        }
        return changed
    }
}
