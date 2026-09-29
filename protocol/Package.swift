// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MabiseoProtocol",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "MabiseoProtocol", targets: ["MabiseoProtocol"])],
  targets: [
    .target(name: "MabiseoProtocol"),
    .testTarget(name: "MabiseoProtocolTests", dependencies: ["MabiseoProtocol"]),
  ]
)
