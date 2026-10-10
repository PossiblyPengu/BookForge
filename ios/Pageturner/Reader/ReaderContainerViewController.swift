import UIKit

/// Wraps the navigator view controller so custom text-selection editing
/// actions have a home in the responder chain. `EditingAction` dispatches
/// `UIApplication.sendAction(_:to:nil)` which walks first-responder → view →
/// view controllers up — this container is the navigator's parent, so its
/// selectors are reachable.
final class ReaderContainerViewController: UIViewController {
    var onHighlightSelection: (() -> Void)?
    var onQuoteSelection: (() -> Void)?

    private let contentController: UIViewController

    init(contentController: UIViewController) {
        self.contentController = contentController
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(contentController)
        contentController.view.frame = view.bounds
        contentController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(contentController.view)
        contentController.didMove(toParent: self)
    }

    /// "Highlight" item in the text-selection menu — the current selection is
    /// read off the navigator when this fires.
    @objc func highlightSelection() {
        onHighlightSelection?()
    }

    /// "Quote" item — sends the selection to BookMaster as a quote.
    @objc func quoteSelection() {
        onQuoteSelection?()
    }
}
