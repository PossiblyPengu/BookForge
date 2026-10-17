import SwiftUI

/// The page's evening light: an amber veil (warmth) and a dark one (dim), over the book and under the chrome.
struct ReaderVeil: View {
    let dim: Double
    let warmth: Double

    var body: some View {
        ZStack {
            if warmth > 0 {
                Color(red: 1, green: 0.6, blue: 0.2)
                    .opacity(min(max(warmth, 0), 1) * 0.3)
                    .blendMode(.multiply)
            }
            if dim > 0 {
                Color.black.opacity(min(max(dim, 0), 0.6))
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The reading ruler: everything but a band of a few lines is dimmed, and a handle at the edge moves the band.
struct ReadingRuler: View {
    @Binding var y: Double
    private let band: CGFloat = 104

    var body: some View {
        GeometryReader { geo in
            let height = max(geo.size.height, 1)
            let center = CGFloat(min(max(y, 0.08), 0.92)) * height
            ZStack {
                Path { p in
                    p.addRect(CGRect(origin: .zero, size: geo.size))
                    p.addRect(CGRect(x: 0, y: center - band / 2, width: geo.size.width, height: band))
                }
                .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))
                .allowsHitTesting(false)

                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 60)
                    .background(Color.black.opacity(0.55), in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
                    .contentShape(Rectangle().inset(by: -8))
                    .position(x: geo.size.width - 22, y: center)
                    .gesture(
                        DragGesture(minimumDistance: 0, coordinateSpace: .named("ruler"))
                            .onChanged { value in
                                y = Double(min(max(value.location.y / height, 0.08), 0.92))
                            }
                    )
                    .accessibilityLabel("Reading ruler")
                    .accessibilityHint("Drag to move it")
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: y = min(y + 0.05, 0.92)
                        case .decrement: y = max(y - 0.05, 0.08)
                        @unknown default: break
                        }
                    }
            }
            .coordinateSpace(name: "ruler")
        }
        .ignoresSafeArea()
    }
}
