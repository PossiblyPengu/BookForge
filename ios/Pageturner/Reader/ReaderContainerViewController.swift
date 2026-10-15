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
        curlPan.delegate = self
        view.addGestureRecognizer(curlPan)
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
        case .fade, .slide, .curl:   // a curl that reaches here falls back to a fade
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

    // MARK: Page curl — the leaf that follows the finger

    /// Wired by ReaderModel: whether a drag from the page's edge may peel the
    /// leaf (curl style, paged — never while the book scrolls), how the
    /// navigator silently moves beneath the overlay, and how a gesture ends.
    var canCurl: (() -> Bool)?
    /// `true` = next page, `false` = previous: silently moves the navigator
    /// (position saves and sync are held until the turn settles). False result
    /// = no page that way.
    var onCurlStep: ((Bool) async -> Bool)?
    var onCurlCommit: (() -> Void)?
    var onCurlCancel: (() async -> Void)?
    /// RTL books peel the other way — set once the navigator exists.
    var rightToLeft = false

    private lazy var curlPan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(curlDragged(_:)))
        pan.maximumNumberOfTouches = 1
        return pan
    }()
    private var curlOverlay: PageCurlOverlay?
    /// Where the finger caught the leaf, and which way the turn goes.
    private var curlGrab: (origin: CGPoint, forward: Bool)?
    /// While the silent move is being prepared the finger keeps moving — the
    /// newest position is what the overlay shows once it exists.
    private var curlPendingTouch: CGPoint?
    private var arming = false
    /// Bumped each time a curl ends or starts — an `armCurl` task that wakes to
    /// a different session knows the gesture already ended and drops its work.
    private var curlSession = 0

    private func snapshotPage() -> UIImage {
        // the navigator's own view — never the overlay covering it
        UIGraphicsImageRenderer(bounds: contentController.view.bounds).image { _ in
            contentController.view.drawHierarchy(
                in: contentController.view.bounds, afterScreenUpdates: false)
        }
    }

    /// A photographed page as a flat sheet — covers the navigator while the
    /// silent moves underneath happen, so the user never sees them flicker.
    private func startCurlCover(_ overlay: PageCurlOverlay, grab: PageCurl.Grab? = nil) {
        overlay.begin(snapshotPage())
        overlay.frame = view.bounds
        overlay.isUserInteractionEnabled = true   // touches for the leaf, not the book
        view.addSubview(overlay)
        curlOverlay = overlay
        if let grab {
            overlay.update(origin: CGPoint(x: grab.origin.x, y: grab.origin.y),
                           touch: CGPoint(x: grab.touch.x, y: grab.touch.y))
        }
    }

    private func removeCurl() {
        curlOverlay?.removeFromSuperview()
        curlOverlay = nil
        curlGrab = nil
        curlPendingTouch = nil
        arming = false
        curlSession += 1
    }

    @objc private func curlDragged(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            curlGrab = nil
            curlPendingTouch = nil
        case .changed:
            let here = pan.location(in: view)
            guard let grab = curlGrab else {
                guard !arming else { curlPendingTouch = here; return }
                // decide the turn the first time the finger travels decisively
                let t = pan.translation(in: view)
                let start = CGPoint(x: here.x - t.x, y: here.y - t.y)
                let onLeft = start.x < view.bounds.width / 2
                // the pull has to run toward the middle of the page
                guard abs(t.x) > 10, abs(t.x) > abs(t.y),
                      onLeft ? t.x > 0 : t.x < 0 else { return }
                // peeling from the right edge turns forward in an LTR book,
                // backward in an RTL one (its fore-edge is on the left)
                let towardLeft = !onLeft
                let forward = towardLeft != rightToLeft
                curlGrab = (origin: start, forward: forward)
                curlPendingTouch = here
                arming = true
                curlSession += 1
                let session = curlSession
                Task { await armCurl(forward: forward, origin: start, session: session) }
                return
            }
            curlPendingTouch = here
            curlOverlay?.update(origin: grab.origin, touch: here)
        case .ended, .cancelled, .failed:
            guard let overlay = curlOverlay, let grab = curlGrab else { removeCurl(); return }
            let v = pan.velocity(in: view)
            let touch = curlPendingTouch ?? grab.origin
            let g = PageCurl.Grab(
                origin: .init(x: Double(grab.origin.x), y: Double(grab.origin.y)),
                touch: .init(x: Double(touch.x), y: Double(touch.y)))
            let p = PageCurl.progress(
                width: Double(view.bounds.width), height: Double(view.bounds.height), grab: g)
            // a flick carries the turn through — the way the peel was already
            // going, which is rightward for a backward LTR peel or a forward
            // RTL one; a slow finger has to be past half
            let peelLeft = grab.forward != rightToLeft
            let fling = peelLeft ? v.x < -450 : v.x > 450
            let commit = p > 0.45 || fling
            let forward = grab.forward
            overlay.isUserInteractionEnabled = false
            overlay.release(origin: grab.origin, touch: touch,
                            velocity: v, commit: commit) { [weak self] in
                Task { [weak self] in
                    guard let self else { return }
                    if commit { await self.finishCurl(forward: forward) }
                    else { await self.onCurlCancel?() }
                    self.removeCurl()
                }
            }
        default: break
        }
    }

    /// Photograph the page, park the navigator on the landing page, then let
    /// the leaf track the finger. A backward peel lifts the leaf already lying
    /// on the left stack — the previous page — so it is photographed by a
    /// silent look behind (and the navigator comes straight back).
    private func armCurl(forward: Bool, origin: CGPoint, session: Int) async {
        guard session == curlSession else { return }     // the finger already let go
        let overlay = PageCurlOverlay(frame: view.bounds)
        if forward {
            startCurlCover(overlay)                       // flat current page over the flicker
            guard await onCurlStep?(true) == true else { failedCurl(session); return }
        } else {
            startCurlCover(overlay)
            guard await onCurlStep?(false) == true else { failedCurl(session); return }
            let arriving = snapshotPage()                  // the previous leaf
            _ = await onCurlStep?(true)                    // back under the cover
            guard session == curlSession else { overlay.removeFromSuperview(); return }
            overlay.begin(arriving)
        }
        guard session == curlSession else { overlay.removeFromSuperview(); return }
        overlay.update(origin: origin, touch: curlPendingTouch ?? origin)
        arming = false
    }

    private func failedCurl(_ session: Int) {
        guard session == curlSession else { return }
        removeCurl()
        Task { await onCurlCancel?() }
    }

    private func finishCurl(forward: Bool) async {
        if !forward { _ = await onCurlStep?(false) }       // the leaf lands on the left stack
        onCurlCommit?()
    }

    /// A tap's scripted curl: the page peels itself off on a soft arc while the
    /// navigator's own (unanimated) turn happens beneath.
    func beginCurl(towardLeft: Bool, frozenAt: Double? = nil) {
        removeCurl()   // a queued curl that never landed goes quietly
        let overlay = PageCurlOverlay(frame: view.bounds)
        startCurlCover(overlay)
        if let frozenAt {
            overlay.pose(frozenAt: frozenAt, towardLeft: towardLeft)
            return
        }
        overlay.animateScripted(towardLeft: towardLeft) { [weak self] in
            self?.removeCurl()
        }
    }

    /// How far in a finger may catch the leaf: the outer quarter of the page,
    /// never narrower than a comfortable grip.
    private var curlEdgeWidth: CGFloat { max(52, view.bounds.width * 0.22) }
}

extension ReaderContainerViewController: UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === curlPan, canCurl?() == true, curlOverlay == nil else { return false }
        let x = g.location(in: view).x
        return x < curlEdgeWidth || x > view.bounds.width - curlEdgeWidth
    }
}
