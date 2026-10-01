import Foundation
import Testing
@testable import OISINTKit

/// Issue #208 完了条件: 「src/theme.ts の colors / radius / rankColors / genreColorMap の全値が
/// Swift 側 DesignTokens と一致することをテストで機械的に検証」（計画書 §5.2）
/// 方式: このテストが実行時に src/theme.ts をパースして期待値を生成し、DesignTokens の rawValue と突合する。
/// theme.ts が見つからない場合は skip せず fail（このリポでは常に同居するため）。
@Suite struct DesignTokensParityTests {
    // MARK: - theme.ts の読み込みとパース

    /// #filePath = <repo>/apple/OISINTKit/Tests/OISINTKitTests/DesignTokensParityTests.swift
    /// から 5 階層上がリポジトリルート
    static let themeSource: String = {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // OISINTKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // OISINTKit
            .deletingLastPathComponent() // apple
            .deletingLastPathComponent() // repo root
        let themeURL = repoRoot.appendingPathComponent("src/theme.ts")
        return (try? String(contentsOf: themeURL, encoding: .utf8)) ?? ""
    }()

    /// `start` と `end` に挟まれた部分文字列を返す
    static func slice(_ source: String, from start: String, to end: String) -> String? {
        guard let startRange = source.range(of: start),
              let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex)
        else { return nil }
        return String(source[startRange.upperBound..<endRange.lowerBound])
    }

    /// NSRegularExpression の全マッチをキャプチャ配列で返す
    static func matches(_ pattern: String, in text: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (1..<match.numberOfRanges).map { i in
                match.range(at: i).location == NSNotFound ? "" : ns.substring(with: match.range(at: i))
            }
        }
    }

    @Test func themeFileIsReadable() {
        #expect(!Self.themeSource.isEmpty, "src/theme.ts が読めない（リポ同居前提のため fail）")
    }

    // MARK: - colors（件数・キー名・値・順序。キー数はハードコードせず theme.ts 実測と突合する。#485）

    @Test func colorsParity() throws {
        let block = try #require(
            Self.slice(Self.themeSource, from: "export const colors = {", to: "} as const;"),
            "theme.ts の colors ブロックが見つからない"
        )
        let expected = Self.matches(#"(\w+):\s*'(#[0-9a-fA-F]{6})'"#, in: block)
        // 0 件はパーサ破損（regex / ブロック抽出の劣化）とみなして fail-closed
        #expect(!expected.isEmpty, "theme.ts の colors を 1 件もパースできない（パーサ破損疑い）")
        #expect(DesignTokens.Colors.all.count == expected.count,
                "colors 件数不一致: theme=\(expected.count) swift=\(DesignTokens.Colors.all.count)")
        for (index, pair) in expected.enumerated() where index < DesignTokens.Colors.all.count {
            let actual = DesignTokens.Colors.all[index]
            #expect(actual.key == pair[0], "colors[\(index)] キー不一致: theme=\(pair[0]) swift=\(actual.key)")
            #expect(actual.token.hex == pair[1], "colors.\(pair[0]) 値不一致: theme=\(pair[1]) swift=\(actual.token.hex)")
        }
    }

    @Test func tagColorsAndReadableForegroundParity() throws {
        let block = try #require(
            Self.slice(Self.themeSource, from: "export const tagColors = {", to: "} as const;"),
            "theme.ts の tagColors ブロックが見つからない"
        )
        let expected = Self.matches(
            #"(\w+):\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})',\s*background:\s*'(#[0-9a-fA-F]{6})'\s*\}"#,
            in: block
        )
        let actual: [(key: String, style: TagStyle)] = [
            ("green", DesignTokens.Components.tagGreen),
            ("blue", DesignTokens.Components.tagBlue),
            ("orange", DesignTokens.Components.tagOrange),
            ("red", DesignTokens.Components.tagRed),
        ]
        #expect(expected.count == actual.count)
        for (index, pair) in expected.enumerated() where index < actual.count {
            #expect(actual[index].key == pair[0])
            #expect(actual[index].style.color.hex == pair[1])
            #expect(actual[index].style.background.hex == pair[2])
            #expect(DesignTokens.contrastRatio(actual[index].style.color, actual[index].style.background) >= 4.5)
        }

        let heroBackgrounds = DesignTokens.genreColorMap.map(\.token)
            + [DesignTokens.genreFallback]
            + DesignTokens.rankColors
        for background in heroBackgrounds {
            let foreground = DesignTokens.readableTextColor(for: background)
            #expect(DesignTokens.contrastRatio(foreground, background) >= 4.5)
        }
    }

    // MARK: - rankColors（件数は theme.ts 実測と突合・順序込み）

    @Test func rankColorsParity() throws {
        let block = try #require(
            Self.slice(Self.themeSource, from: "export const rankColors = [", to: "] as const;"),
            "theme.ts の rankColors が見つからない"
        )
        let expected = Self.matches(#"'(#[0-9a-fA-F]{6})'"#, in: block).map { $0[0] }
        #expect(!expected.isEmpty, "theme.ts の rankColors を 1 件もパースできない（パーサ破損疑い）")
        #expect(DesignTokens.rankColors.count == expected.count,
                "rankColors 件数不一致: theme=\(expected.count) swift=\(DesignTokens.rankColors.count)")
        #expect(DesignTokens.rankColors.map(\.hex) == expected)
    }

    /// theme.ts `rankColor(rank)` のロジック同値性（clamp 1..5）
    @Test func rankColorLogicParity() {
        let ranks = [0, 1, 3, 5, 9]
        let expectedIndices = ranks.map { min(max($0, 1), 5) - 1 } // theme.ts L41 の規則
        for (rank, index) in zip(ranks, expectedIndices) {
            #expect(DesignTokens.rankColor(rank).hex == DesignTokens.rankColors[index].hex,
                    "rankColor(\(rank)) は rankColors[\(index)] のはず")
        }
    }

    // MARK: - radius（件数は theme.ts 実測と突合）

    @Test func radiusParity() throws {
        let block = try #require(
            Self.slice(Self.themeSource, from: "export const radius = {", to: "} as const;"),
            "theme.ts の radius ブロックが見つからない"
        )
        let expected = Self.matches(#"(\w+):\s*(\d+)"#, in: block)
        #expect(!expected.isEmpty, "theme.ts の radius を 1 件もパースできない（パーサ破損疑い）")
        #expect(DesignTokens.Radius.all.count == expected.count,
                "radius 件数不一致: theme=\(expected.count) swift=\(DesignTokens.Radius.all.count)")
        for (index, pair) in expected.enumerated() where index < DesignTokens.Radius.all.count {
            let actual = DesignTokens.Radius.all[index]
            #expect(actual.key == pair[0], "radius[\(index)] キー不一致: theme=\(pair[0]) swift=\(actual.key)")
            #expect(actual.value == CGFloat(Int(pair[1]) ?? -1), "radius.\(pair[0]) 値不一致")
        }
    }

    // MARK: - genreColorMap（件数は theme.ts 実測と突合・順序込み）+ fallback

    @Test func genreColorMapParity() throws {
        let block = try #require(
            Self.slice(Self.themeSource, from: "const genreColorMap: [string, string][] = [", to: "];"),
            "theme.ts の genreColorMap が見つからない"
        )
        let expected = Self.matches(#"\['([^']+)',\s*'(#[0-9a-fA-F]{6})'\]"#, in: block)
        #expect(!expected.isEmpty, "theme.ts の genreColorMap を 1 件もパースできない（パーサ破損疑い）")
        #expect(DesignTokens.genreColorMap.count == expected.count,
                "genreColorMap 件数不一致: theme=\(expected.count) swift=\(DesignTokens.genreColorMap.count)")
        for (index, pair) in expected.enumerated() where index < DesignTokens.genreColorMap.count {
            let actual = DesignTokens.genreColorMap[index]
            #expect(actual.genre == pair[0], "genreColorMap[\(index)] ジャンル名不一致: theme=\(pair[0]) swift=\(actual.genre)")
            #expect(actual.token.hex == pair[1], "genreColorMap[\(pair[0])] 値不一致")
        }
    }

    @Test func genreFallbackParity() throws {
        let fn = try #require(
            Self.slice(Self.themeSource, from: "export function genreColor", to: "\n}"),
            "theme.ts の genreColor 関数が見つからない"
        )
        let fallbacks = Self.matches(#"return\s+'(#[0-9a-fA-F]{6})';"#, in: fn).map { $0[0] }
        let expected = try #require(fallbacks.last, "genreColor の fallback hex が見つからない")
        #expect(DesignTokens.genreFallback.hex == expected)
    }

    /// theme.ts `genreColor(genre)` のロジック同値性（includes による前方からの部分一致）
    @Test func genreColorLogicParity() {
        // "味噌ラーメン" は 'ラーメン' を含む → #f6a636
        #expect(DesignTokens.genreColor("味噌ラーメン").hex == "#f6a636")
        // "つけ麺 専門" は 'つけ麺' を含む → #f6a636
        #expect(DesignTokens.genreColor("つけ麺 専門").hex == "#f6a636")
        // 一致なし → fallback
        #expect(DesignTokens.genreColor("該当なし").hex == "#83abb2")
        // nil → fallback
        #expect(DesignTokens.genreColor(nil).hex == "#83abb2")
        // mock データの実ジャンル
        #expect(DesignTokens.genreColor("焼肉").hex == "#b94d4d")
        #expect(DesignTokens.genreColor("居酒屋").hex == "#7cb0b5")
        #expect(DesignTokens.genreColor("ステーキ").hex == "#b94d4d")
    }
}
