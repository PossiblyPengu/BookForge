import Foundation
import UIKit

/// One possible match from an online metadata source.
struct MetadataCandidate: Identifiable, Hashable {
    let id = UUID()
    var title: String
    var authors: String
    var year: String
    var coverURL: URL?
    var source: String
}

/// Book metadata lookup — Google Books + Open Library, mirroring the web
/// app's metadata.js. Only ever called on an explicit user action (the Edit
/// sheet's "Find Metadata Online" button), never automatically.
enum MetadataLookup {
    static func search(title: String, author: String) async -> [MetadataCandidate] {
        async let gb = googleBooks(title: title, author: author)
        async let ol = openLibrary(title: title, author: author)
        return dedupe(await gb + await ol)
    }

    private static func dedupe(_ candidates: [MetadataCandidate]) -> [MetadataCandidate] {
        var seen = Set<String>()
        var out: [MetadataCandidate] = []
        for c in candidates {
            let key = (c.title + "|" + c.authors)
                .lowercased()
                .filter { $0.isLetter || $0.isNumber }
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            out.append(c)
        }
        return out
    }

    // MARK: - Google Books

    private static func googleBooks(title: String, author: String) async -> [MetadataCandidate] {
        var q = "intitle:\(title)"
        if !author.isEmpty { q += " inauthor:\(author)" }
        guard var comp = URLComponents(string: "https://www.googleapis.com/books/v1/volumes") else { return [] }
        comp.queryItems = [
            URLQueryItem(name: "q", value: q),
            URLQueryItem(name: "maxResults", value: "8"),
            URLQueryItem(name: "fields", value: "items(volumeInfo(title,authors,publishedDate,imageLinks))"),
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
            return MetadataCandidate(title: t, authors: authors, year: year, coverURL: cover, source: "Google Books")
        }
    }

    // MARK: - Open Library

    private static func openLibrary(title: String, author: String) async -> [MetadataCandidate] {
        guard var comp = URLComponents(string: "https://openlibrary.org/search.json") else { return [] }
        var items = [
            URLQueryItem(name: "title", value: title),
            URLQueryItem(name: "limit", value: "8"),
            URLQueryItem(name: "fields", value: "title,author_name,first_publish_year,cover_i"),
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
            return MetadataCandidate(title: t, authors: authors, year: year, coverURL: cover, source: "Open Library")
        }
    }

    /// Download a candidate's cover into the covers folder for `book`.
    static func applyCover(from url: URL, to book: Book, library: LibraryStore) async {
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let image = UIImage(data: data),
              let jpeg = image.jpegData(compressionQuality: 0.85)
        else { return }
        await MainActor.run {
            try? jpeg.write(to: library.coverURL(for: book))
        }
    }
}
