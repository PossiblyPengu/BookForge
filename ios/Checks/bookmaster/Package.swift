// swift-tools-version:5.9
import PackageDescription

// A contract check: the app's real BookMaster Swift sources, compiled on Linux
// or macOS and driven against a live local BookMaster. See README.md.
let package = Package(
    name: "bmcheck",
    targets: [.executableTarget(name: "bmcheck", path: "Sources/bmcheck")]
)
