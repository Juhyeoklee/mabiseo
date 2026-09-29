// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MabiseoClient",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "MabiseoClient", targets: ["MabiseoClient"])],
  dependencies: [.package(path: "../protocol")],
  targets: [
    .target(name: "MabiseoClient", dependencies: [.product(name: "MabiseoProtocol", package: "protocol")]),
    .testTarget(name: "MabiseoClientTests", dependencies: ["MabiseoClient"]),
  ]
)
