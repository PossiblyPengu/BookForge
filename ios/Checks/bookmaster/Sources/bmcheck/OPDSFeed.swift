import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

/// An OPDS catalogue page (Atom): what a Calibre content server, Project Gutenberg and most open
/// libraries speak. Pure parsing — no network — so it can be checked off-device.
struct OPDSFeed: Equatable {
    var title = ""
    var entries: [OPDSEntry] = []
    /// The next page of a long listing.
    var next: URL?
    /// A search URL with `{searchTerms}` in it, when the catalogue has a search.
    var searchTemplate: String?
    /// An OpenSearch description to fetch for the template, when the feed only points at one.
    var searchDescription: URL?
}

struct OPDSEntry: Equatable, Identifiable {
    var id: String
    var title = ""
    var author = ""
    var summary = ""
    var cover: URL?
    /// A listing to open (a shelf, an author, a letter).
    var navigation: URL?
    /// Files the entry offers, best first.
    var downloads: [OPDSDownload] = []
}

struct OPDSDownload: Equatable {
    var url: URL
    /// The MIME type the feed gave.
    var type: String

    /// The extension the saved file gets, from the type or the address.
    var fileExtension: String {
        let t = type.lowercased()
        if t.contains("epub") { return "epub" }
        if t.contains("pdf") { return "pdf" }
        if t.contains("comicbook+zip") || t.contains("cbz") { return "cbz" }
        if t.contains("m4b") || t.contains("mp4") || t.contains("m4a") { return "m4b" }
        if t.contains("mpeg") || t.contains("mp3") { return "mp3" }
        if t.contains("text/plain") { return "txt" }
        let ext = url.pathExtension.lowercased()
        return ext.isEmpty ? "epub" : ext
    }

    /// Formats the library can open, in the order worth taking.
    static let preferred = ["epub", "pdf", "cbz", "m4b", "mp3", "txt"]
}

enum OPDS {
    /// Parse a feed. `base` resolves the relative links it carries.
    static func parse(_ data: Data, base: URL) -> OPDSFeed? {
        let delegate = FeedParser(base: base)
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = false
        parser.delegate = delegate
        guard parser.parse() else { return nil }
        guard delegate.sawFeed else { return nil }
        return delegate.feed
    }

    /// The search address in an OpenSearch description document.
    static func searchTemplate(fromDescription data: Data) -> String? {
        let delegate = DescriptionParser()
        let parser = XMLParser(data: data)
        parser.delegate = delegate
        _ = parser.parse()
        return delegate.template
    }

    /// The search URL for `terms`, percent-encoded into the template.
    static func searchURL(template: String, terms: String, base: URL) -> URL? {
        let encoded = terms.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) ?? terms
        let filled = template
            .replacingOccurrences(of: "{searchTerms}", with: encoded)
            .replacingOccurrences(of: "{startPage?}", with: "1")
            .replacingOccurrences(of: "{startIndex?}", with: "0")
            .replacingOccurrences(of: "{count?}", with: "50")
        // any optional {x?} parameter left over means nothing
        let cleaned = filled.replacingOccurrences(of: "\\{[^}]*\\?\\}", with: "", options: .regularExpression)
        return URL(string: cleaned, relativeTo: base)?.absoluteURL
    }

    private final class FeedParser: NSObject, XMLParserDelegate {
        let base: URL
        var feed = OPDSFeed()
        var sawFeed = false

        private var path: [String] = []
        private var text = ""
        private var entry: OPDSEntry?
        /// A summary can hold markup of its own: everything inside it is its text.
        private var summaryDepth = 0
        private var summaryText = ""

        init(base: URL) { self.base = base }

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            path.append(name)
            text = ""
            if summaryDepth > 0 {
                summaryDepth += 1
            } else if entry != nil, name == "summary" || name == "content" {
                summaryDepth = 1
                summaryText = ""
            }
            switch name {
            case "feed": sawFeed = true
            case "entry": entry = OPDSEntry(id: UUID().uuidString)
            case "link": link(attributes)
            default: break
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            text += string
            if summaryDepth > 0 { summaryText += string }
        }

        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            let chunk = String(data: CDATABlock, encoding: .utf8) ?? ""
            text += chunk
            if summaryDepth > 0 { summaryText += chunk }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            defer { path.removeLast(); text = "" }
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let inEntry = entry != nil
            if summaryDepth > 0 {
                summaryDepth -= 1
                if summaryDepth == 0, inEntry, entry?.summary.isEmpty == true {
                    entry?.summary = Self.plain(summaryText)
                }
                return
            }
            switch name {
            case "title":
                if inEntry { entry?.title = value } else if path.count == 2 { feed.title = value }
            case "id":
                if inEntry, !value.isEmpty { entry?.id = value }
            case "name":
                if var current = entry, path.dropLast().last == "author", !value.isEmpty {
                    current.author = current.author.isEmpty ? value : current.author + " & " + value
                    entry = current
                }
            case "entry":
                if var finished = entry {
                    finished.downloads.sort { rank($0) < rank($1) }
                    feed.entries.append(finished)
                }
                entry = nil
            default: break
            }
        }

        private func rank(_ d: OPDSDownload) -> Int {
            OPDSDownload.preferred.firstIndex(of: d.fileExtension) ?? OPDSDownload.preferred.count
        }

        private func link(_ a: [String: String]) {
            guard let href = a["href"], !href.isEmpty,
                  let url = URL(string: href, relativeTo: base)?.absoluteURL else { return }
            let rel = (a["rel"] ?? "").lowercased()
            let type = (a["type"] ?? "").lowercased()
            if entry != nil {
                if rel.contains("opds-spec.org/acquisition") {
                    // a store's "buy" or "sample" is not a file we can have
                    if rel.hasSuffix("/buy") || rel.hasSuffix("/sample") || rel.hasSuffix("/subscribe") { return }
                    let download = OPDSDownload(url: url, type: type)
                    if OPDSDownload.preferred.contains(download.fileExtension) { entry?.downloads.append(download) }
                } else if rel.contains("image/thumbnail") || rel.hasSuffix("/thumbnail") {
                    if entry?.cover == nil { entry?.cover = url }
                } else if rel.contains("opds-spec.org/image") {
                    if entry?.cover == nil { entry?.cover = url }
                } else if type.contains("atom+xml"), entry?.navigation == nil,
                          rel.isEmpty || rel == "subsection" || rel == "alternate" || rel.contains("sort/") || rel.contains("crawlable") || rel.contains("related") || rel == "http://opds-spec.org/shelf" {
                    entry?.navigation = url
                }
            } else {
                if rel == "next" { feed.next = url }
                if rel == "search" {
                    if href.contains("{searchTerms}") || href.removingPercentEncoding?.contains("{searchTerms}") == true {
                        feed.searchTemplate = href.removingPercentEncoding ?? href
                        if let resolved = URL(string: feed.searchTemplate!, relativeTo: base) {
                            feed.searchTemplate = resolved.absoluteString.removingPercentEncoding ?? resolved.absoluteString
                        }
                    } else if type.contains("opensearchdescription") {
                        feed.searchDescription = url
                    }
                }
            }
        }

        /// A summary can carry HTML.
        private static func plain(_ s: String) -> String {
            s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
                .replacingOccurrences(of: "&amp;", with: "&")
                .replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">")
                .replacingOccurrences(of: "&quot;", with: "\"")
                .replacingOccurrences(of: "&#39;", with: "'")
                .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }
    }

    private final class DescriptionParser: NSObject, XMLParserDelegate {
        var template: String?
        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            guard name == "Url", template == nil, let t = attributes["template"],
                  (attributes["type"] ?? "").contains("atom") else { return }
            template = t
        }
    }
}
