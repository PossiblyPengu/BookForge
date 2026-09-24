import Foundation
import ReadiumNavigator
import ReadiumShared
import SwiftUI

@MainActor
final class ReaderModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var book: Book
    @Published var showChrome = true
    @Published var settings = ReaderSettings.load()
    @Published var toc: [Link] = []
    @Published var canReadAloud = false
    @Published private(set) var readAloud: ReadAloud?
    @Published var notice: String?

    private let library: LibraryStore
    private var publication: Publication?
    private var navigator: (any VisualNavigator)?
    private(set) var navigatorController: UIViewController?
    private var directionalAdapter: DirectionalNavigationAdapter?
    private var inputTokens: Set<InputObservableToken> = []

    nonisolated init(book: Book, library: LibraryStore) {
        self.book = book
        self.library = library
    }

    func open() async {
        do {
            let publication = try await Readium.shared.open(url: library.fileURL(for: book))
            self.publication = publication
            let initial = book.locatorJSON.flatMap { try? Locator(jsonString: $0) }

            if publication.conforms(to: .epub) {
                let nav = try EPUBNavigatorViewController(
                    publication: publication,
                    initialLocation: initial,
                    config: .init(preferences: settings.epubPreferences)
                )
                nav.delegate = self
                install(navigator: nav, controller: nav)
            } else if publication.conforms(to: .pdf) {
                let nav = try PDFNavigatorViewController(
                    publication: publication,
                    initialLocation: initial,
                    config: .init(),
                    delegate: self
                )
                install(navigator: nav, controller: nav)
            } else {
                phase = .failed("This book's format isn't supported yet.")
                return
            }

            book.lastOpenedAt = Date()
            library.update(book)
            canReadAloud = ReadAloud.canSpeak(publication)
            toc = (try? await publication.tableOfContents().get()) ?? []
            if toc.isEmpty { toc = publication.readingOrder }
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Edge taps turn pages (DirectionalNavigationAdapter); anything left over
    /// toggles the chrome — same setup as the Readium Test App.
    private func install(navigator: any VisualNavigator, controller: UIViewController) {
        self.navigator = navigator
        navigatorController = controller

        let adapter = DirectionalNavigationAdapter(animatedTransition: true)
        adapter.bind(to: navigator)
        directionalAdapter = adapter

        navigator.addObserver(.activate { [weak self] _ in
            self?.toggleChrome()
            return true
        }).store(in: &inputTokens)
    }

    func toggleChrome() {
        withAnimation { showChrome.toggle() }
    }

    func go(to link: Link) {
        guard let navigator else { return }
        Task { _ = await navigator.go(to: link) }
    }

    func applySettings() {
        settings.save()
        (navigatorController as? EPUBNavigatorViewController)?
            .submitPreferences(settings.epubPreferences)
        readAloud?.setRate(settings.speechRate)
        readAloud?.setVoice(settings.voiceIdentifier)
    }

    // MARK: - Read aloud

    func toggleReadAloud() {
        if let readAloud {
            readAloud.playPause()
        } else {
            startReadAloud()
        }
    }

    private func startReadAloud() {
        guard let publication, let navigator,
              let readAloud = ReadAloud(
                  publication: publication,
                  navigator: navigator,
                  settings: settings
              )
        else { return }
        self.readAloud = readAloud
        readAloud.start()
    }

    func stopReadAloud() {
        readAloud?.stop()
        readAloud = nil
    }

    func cycleRate() {
        let steps: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
        settings.speechRate = steps.first { $0 > settings.speechRate + 0.001 } ?? steps[0]
    }
}

// MARK: - Navigator delegates

extension ReaderModel: EPUBNavigatorDelegate, PDFNavigatorDelegate {
    func navigator(_ navigator: Navigator, locationDidChange locator: Locator) {
        book.locatorJSON = try? locator.jsonString()
        book.progression = locator.locations.totalProgression
        library.update(book)
    }

    func navigator(_ navigator: Navigator, presentError error: NavigatorError) {
        notice = "This action isn't allowed in this publication."
    }
}
