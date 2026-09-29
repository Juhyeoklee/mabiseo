import ProjectDescription

let project = Project(
  name: "Mabiseo",
  packages: [.local(path: "..")],
  settings: .settings(base: [
    "DEVELOPMENT_TEAM": .string(Environment.team.getString(default: "")),
    "CODE_SIGN_STYLE": "Automatic",
    "SWIFT_VERSION": "6.0",
  ]),
  targets: [
    .target(
      name: "Mabiseo",
      destinations: .iOS,
      product: .app,
      bundleId: "com.zetciti.mabiseo",
      deploymentTargets: .iOS("17.0"),
      infoPlist: .extendingDefault(with: [
        "CFBundleDisplayName": "마비서",
        "NSLocalNetworkUsageDescription": "같은 와이파이에 있는 PC의 마비서를 찾습니다.",
        "NSBonjourServices": ["_mabiseo._tcp"],
        "NSAppTransportSecurity": ["NSAllowsLocalNetworking": true],
        "UILaunchScreen": [:],
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
      ]),
      sources: ["Sources/**"],
      dependencies: [.package(product: "MabiseoClient", type: .runtime)]
    ),
  ]
)
