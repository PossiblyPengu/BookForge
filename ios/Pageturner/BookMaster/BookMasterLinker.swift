import Foundation

/// Where a pair flow stands, and what to do with the code it ends with.
///
/// The flow itself runs in `BookMasterLinkSheet`; the addresses it reads are in
/// `BMLinkURL`.
@MainActor
final class BookMasterLinker {
    static let shared = BookMasterLinker()
    static let scheme = BMLinkURL.scheme

    /// True only while the link sheet is up. A `pageturner://link` URL that
    /// arrives any other time — say from a web page — didn't come from a link the
    /// reader started, so it must not link their device.
    var pending = false

    /// The code carried by a `pageturner://link?code=…` URL, if it is one.
    static func code(from url: URL) -> String? { BMLinkURL.code(fromAppURL: url) }

    /// The sheet gave back a code: spend it. Returns what went wrong, or nil.
    func finish(code: String) async -> String? {
        pending = false
        do {
            try await BookMaster.shared.redeem(code: code)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
