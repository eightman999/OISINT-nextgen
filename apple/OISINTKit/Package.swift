// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "OISINTKit",
    defaultLocalization: "ja",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "OISINTKit", targets: ["OISINTKit"]),
        // Debug/Test専用fixture。Releaseアプリはこのproductへ依存しない。
        .library(name: "OISINTKitDebugFixtures", targets: ["OISINTKitDebugFixtures"])
    ],
    dependencies: [
        // 供給網リスク緩和のため exact pin（公開 7 日超の版のみ許可。計画書 §2.5）
        .package(url: "https://github.com/supabase/supabase-swift.git", exact: "2.54.1"),
        .package(url: "https://github.com/RevenueCat/purchases-ios.git", exact: "5.83.1")
    ],
    targets: [
        .target(
            name: "OISINTKit",
            dependencies: [
                // Supabase 統合クライアントを使う（auth → PostgREST/Realtime の JWT 連携が内蔵のため。
                // 個別 product 構成だとトークンリフレッシュ連携を自前実装することになり §2.5 の
                // 「Realtime 自前実装リスク回避」という決定理由に反する）。
                // 呼び出すのは auth / from / rpc / channel のみ。Functions / Storage の API は使わない。
                .product(name: "Supabase", package: "supabase-swift"),
                .product(name: "RevenueCat", package: "purchases-ios")
            ],
            resources: [
                // ブランドロゴ（assets/branding/oisint-logo-horizontal.png のコピー。
                // Web Home は実測でロゴ画像を表示しており #241 で同一表示に揃えた）
                .process("Resources")
            ]
        ),
        .target(
            name: "OISINTKitDebugFixtures",
            dependencies: ["OISINTKit"],
            path: "Sources/OISINTKitDebugFixtures"
        ),
        .testTarget(
            name: "OISINTKitTests",
            dependencies: ["OISINTKit", "OISINTKitDebugFixtures"]
        ),
    ]
)
