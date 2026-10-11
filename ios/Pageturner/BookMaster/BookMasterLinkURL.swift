import Foundation

/// The addresses BookMaster's pair flow passes through. Pure parsing — no UIKit —
/// so the rules can be checked off-device.
///
/// The flow: the app opens BookMaster's link page and says which Pageturner asked
/// (`from`); once the reader is signed in BookMaster mints a one-time code and
/// sends the browser to `<from>/?bm-link=<code>`. The app never lets that request
/// go out — it reads the code off the address (see `BookMasterLinkSheet`), which
/// is why linking needs no deployed website. A deployed site that hands the code
/// on as `pageturner://link?code=<code>` is understood too.
enum BMLinkURL {
    static let scheme = "pageturner"
    static let bookMasterHost = "bookmaster.pages.dev"
    static let pageturnerHost = "pageturner.pages.dev"

    /// Where the flow starts: BookMaster's link page, told which build is asking
    /// (a host BookMaster allows sending the code back to).
    static var start: URL {
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = bookMasterHost
        parts.path = "/link/pageturner"
        parts.queryItems = [URLQueryItem(name: "from", value: "https://\(pageturnerHost)")]
        return parts.url!
    }

    /// Codes are the hex ids BookMaster mints; anything else is not a code.
    static func plausible(_ code: String) -> Bool {
        let length = code.count
        guard (8...128).contains(length) else { return false }
        return code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// The code in `pageturner://link?code=…`.
    static func code(fromAppURL url: URL) -> String? {
        guard url.scheme == scheme, url.host == "link" else { return nil }
        return value("code", in: url)
    }

    /// The code in BookMaster's return address: `https://<a Pageturner host>/?bm-link=…`
    /// — production, or one of its preview builds.
    static func code(fromReturn url: URL) -> String? {
        guard url.scheme == "https", let host = url.host?.lowercased(),
              host == pageturnerHost || host.hasSuffix(".\(pageturnerHost)")
        else { return nil }
        return value("bm-link", in: url)
    }

    /// Either shape.
    static func code(from url: URL) -> String? {
        code(fromAppURL: url) ?? code(fromReturn: url)
    }

    /// Whether the link sheet may show this address: BookMaster's own pages. Any
    /// other page the flow tries to open is refused, so the sheet can't be sent
    /// somewhere that asks for a BookMaster password.
    static func isBookMasterPage(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return host == bookMasterHost
    }

    private static func value(_ name: String, in url: URL) -> String? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let value = items.first(where: { $0.name == name })?.value,
              plausible(value)
        else { return nil }
        return value
    }
}
