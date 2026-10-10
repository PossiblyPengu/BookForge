import SwiftUI
import UIKit

// The one place that knows about Liquid Glass. Everywhere else calls these
// helpers, so there is no `#available` at call sites: iOS 26 gets the real
// glass, earlier systems get the closest plain material.

// MARK: - Colour

extension Color {
    /// BookMaster's terracotta: the lighter evening clay in the dark room, the
    /// deeper clay in the light one.
    static let ptAccent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xCD / 255, green: 0x84 / 255, blue: 0x4F / 255, alpha: 1)
            : UIColor(red: 0xA0 / 255, green: 0x53 / 255, blue: 0x2A / 255, alpha: 1)
    })
}

// MARK: - Glass behind a floating control

extension View {
    /// Liquid Glass behind a control that floats above content; a thin
    /// material before iOS 26. Never put it on content, and don't stack it on
    /// other glass — group neighbours in a `PTGlassGroup` instead.
    @ViewBuilder
    func ptGlass<S: Shape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(Self.glass(tint: tint, interactive: interactive), in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
        }
    }

    /// Glass in a capsule — pills, scrubbers, title chips.
    func ptGlassCapsule(tint: Color? = nil, interactive: Bool = false) -> some View {
        ptGlass(in: Capsule(), tint: tint, interactive: interactive)
    }

    @available(iOS 26, *)
    private static func glass(tint: Color?, interactive: Bool) -> Glass {
        var glass: Glass = .regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }
}

/// Neighbouring glass shapes blend and morph together inside one container.
struct PTGlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

// MARK: - Buttons

extension View {
    /// `.glass` / `.glassProminent` on iOS 26, `.bordered` / `.borderedProminent` before.
    @ViewBuilder
    func ptButtonStyle(prominent: Bool = false) -> some View {
        if #available(iOS 26, *) {
            if prominent { self.buttonStyle(.glassProminent) } else { self.buttonStyle(.glass) }
        } else {
            if prominent { self.buttonStyle(.borderedProminent) } else { self.buttonStyle(.bordered) }
        }
    }
}

/// A round icon button on glass — the reader's back button, the player's
/// close button. The label is for VoiceOver; the icon is for everyone else.
struct PTIconButton: View {
    let systemImage: String
    let label: String
    var size: CGFloat = 44
    var tint: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.4, weight: .semibold))
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint ?? Color.primary)
        .ptGlass(in: Circle(), interactive: true)
        .accessibilityLabel(label)
    }
}

// MARK: - Scrolling and tab bars

extension View {
    /// Content scrolls softly under the bars rather than hitting a hard edge.
    @ViewBuilder
    func ptSoftScrollEdges() -> some View {
        if #available(iOS 26, *) {
            self.scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
    }

    /// The tab bar shrinks away as you scroll down and returns on scroll up.
    @ViewBuilder
    func ptMinimizingTabBar() -> some View {
        if #available(iOS 26, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }

    /// Extend a hero image or tint behind the bars it sits under.
    @ViewBuilder
    func ptBackgroundExtension() -> some View {
        if #available(iOS 26, *) {
            self.backgroundExtensionEffect()
        } else {
            self
        }
    }
}
