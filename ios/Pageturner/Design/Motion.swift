import SwiftUI

// Motion, in one place, so every animation steps aside for Reduce Motion.

private struct MotionModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

extension View {
    /// `animation(_:value:)` that does nothing when the reader has asked for less motion.
    func ptAnimation<V: Equatable>(_ animation: Animation = .smooth(duration: 0.3), value: V) -> some View {
        modifier(MotionModifier(animation: animation, value: value))
    }

    /// A symbol that changes into another (play ↔ pause) rather than snapping.
    func ptSymbolSwap<V: Equatable>(on value: V) -> some View {
        self
            .contentTransition(.symbolEffect(.replace))
            .ptAnimation(.smooth(duration: 0.25), value: value)
    }

    /// A number that rolls to its new value.
    func ptNumberRoll<V: Equatable>(on value: V) -> some View {
        self
            .contentTransition(.numericText())
            .ptAnimation(.smooth(duration: 0.3), value: value)
    }
}

/// Covers and cards give a little under a finger, then spring back.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.28, bounce: 0.3), value: configuration.isPressed)
    }
}
