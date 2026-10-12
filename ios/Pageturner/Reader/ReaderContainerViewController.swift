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

    // MARK: Turning the page

    private var turning: UIView?
    private static let turnDuration: CFTimeInterval = 0.55

    /// Lay the page as it is over the navigator and turn it away, while the navigator moves on to the next
    /// beneath it. `towardLeft`: the page leaves to the left (a tap on the right edge turns forward).
    /// `frozenAt` holds the turn part way (0...1), for the simulator's photographs.
    func beginTurn(towardLeft: Bool, style: PageTurnStyle, frozenAt: Double? = nil) {
        guard style != .slide else { return }
        turning?.removeFromSuperview()
        let bounds = view.bounds
        guard bounds.width > 0 else { return }
        let image = UIGraphicsImageRenderer(bounds: bounds).image { _ in
            view.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }

        let holder = UIView(frame: bounds)
        holder.isUserInteractionEnabled = false
        let shade = UIView(frame: bounds)       // the page beneath, in the turning page's shadow
        shade.backgroundColor = .black
        shade.alpha = 0
        let page = UIImageView(image: image)
        page.frame = bounds
        page.clipsToBounds = true
        let veil = UIView(frame: bounds)        // the turning page darkens as it goes edge-on
        veil.backgroundColor = .black
        veil.alpha = 0
        page.addSubview(veil)
        holder.addSubview(shade)
        holder.addSubview(page)
        view.addSubview(holder)
        turning = holder

        // a photograph of the turn part way: the page drawn at that angle, no animation to pause
        if let frozenAt, style == .flip {
            let progress = CGFloat(min(max(frozenAt, 0), 1))
            let hinge: CGFloat = towardLeft ? 0 : 1
            page.layer.anchorPoint = CGPoint(x: hinge, y: 0.5)
            page.layer.position = CGPoint(x: bounds.width * hinge, y: bounds.midY)
            var start = CATransform3DIdentity
            start.m34 = -1 / 1400
            page.layer.transform = CATransform3DRotate(start, (towardLeft ? -1 : 1) * .pi / 2 * progress, 0, 1, 0)
            veil.alpha = 0.55 * progress
            shade.alpha = 0.38
            return
        }

        let d = style == .flip ? Self.turnDuration : 0.3
        let ease = CAMediaTimingFunction(controlPoints: 0.32, 0, 0.2, 1)
        func animation(_ key: String, from: Any, to: Any) -> CABasicAnimation {
            let a = CABasicAnimation(keyPath: key)
            a.fromValue = from
            a.toValue = to
            a.duration = d
            a.timingFunction = ease
            a.fillMode = .both
            a.isRemovedOnCompletion = false
            return a
        }

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak holder, weak self] in
            holder?.removeFromSuperview()
            if self?.turning === holder { self?.turning = nil }
        }
        switch style {
        case .flip:
            let hinge: CGFloat = towardLeft ? 0 : 1
            page.layer.anchorPoint = CGPoint(x: hinge, y: 0.5)
            page.layer.position = CGPoint(x: bounds.width * hinge, y: bounds.midY)
            var start = CATransform3DIdentity
            start.m34 = -1 / 1400
            let end = CATransform3DRotate(start, (towardLeft ? -1 : 1) * .pi / 2, 0, 1, 0)
            page.layer.add(animation("transform", from: start, to: end), forKey: "turn")
            veil.layer.add(animation("opacity", from: 0, to: 0.55), forKey: "veil")
            let shadow = CAKeyframeAnimation(keyPath: "opacity")
            shadow.values = [0, 0.38, 0.0]
            shadow.keyTimes = [0, 0.45, 1]
            shadow.duration = d
            shadow.fillMode = .both
            shadow.isRemovedOnCompletion = false
            shade.layer.add(shadow, forKey: "shadow")
        case .fade, .slide:
            page.layer.add(animation("opacity", from: 1, to: 0), forKey: "fade")
        }
        CATransaction.commit()
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
