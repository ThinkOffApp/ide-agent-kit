// swift-tools-version: 5.9
// SPDX-License-Identifier: AGPL-3.0

import PackageDescription

let package = Package(
    name: "UserIntentKit",
    platforms: [
        .watchOS(.v9),
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "UserIntentKit", targets: ["UserIntentKit"]),
    ],
    targets: [
        .target(name: "UserIntentKit", path: "Sources/UserIntentKit"),
    ]
)
