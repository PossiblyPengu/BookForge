import AuthenticationServices
import UIKit

/// Runs BookMaster's pair flow in an in-app browser sheet.
///
/// BookMaster mints a one-time code and returns it to
/// `https://pageturner.pages.dev/?bm-link=<code>`. That page hands the code to
/// the app as `pageturner://link?code=<code>`, which is what ends the sheet
/// (a sideloaded app has no associated domain for an https callback).
@MainActor
final class BookMasterLinker: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = BookMasterLinker()
    static let scheme = "pageturner"

    private var session: ASWebAuthenticationSession?

    /// The code carried by a `pageturner://link?code=…` URL, if it is one.
    static func code(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "link",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "code" }?.value
    }

    func link() async throws {
        var parts = URLComponents(string: "https://bookmaster.pages.dev/link/pageturner")!
        parts.queryItems = [URLQueryItem(name: "from", value: "https://pageturner.pages.dev")]
        let start = parts.url!
        let code: String = try await withCheckedThrowingContinuation { continuation in
            let s = ASWebAuthenticationSession(url: start, callbackURLScheme: Self.scheme) { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url, let code = Self.code(from: url) {
                    continuation.resume(returning: code)
                } else {
                    continuation.resume(throwing: BMError.server(0, "BookMaster didn’t send a link code"))
                }
            }
            s.presentationContextProvider = self
            // share Safari's session so an existing BookMaster login is reused
            s.prefersEphemeralWebBrowserSession = false
            self.session = s
            s.start()
        }
        session = nil
        try await BookMaster.shared.redeem(code: code)
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
        }
    }
}
