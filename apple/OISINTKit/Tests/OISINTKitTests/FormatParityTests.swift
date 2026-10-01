import Foundation
import Testing
@testable import OISINTKit

/// src/lib/format.ts との逐語一致検証（計画書 Phase 4 完了条件を Phase 2 で前倒し実装）。
/// matchStateSymbol / statusLabel / voteSymbol / statusOrder は format.ts を実行時にパースして突合する。
@Suite struct FormatParityTests {
    static let formatSource: String = {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repoRoot.appendingPathComponent("src/lib/format.ts")
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }()

    /// `case '<key>':`（直後に default: を挟んでもよい）から `return '<value>';` の組を抽出
    static func caseReturns(function name: String) -> [String: String] {
        guard let fn = DesignTokensParityTests.slice(Self.formatSource, from: "export function \(name)", to: "\n}") else {
            return [:]
        }
        var result: [String: String] = [:]
        for match in DesignTokensParityTests.matches(#"case '(\w+)':\s*(?:default:\s*)?return '([^']*)';"#, in: fn) {
            result[match[0]] = match[1]
        }
        return result
    }

    @Test func formatFileIsReadable() {
        #expect(!Self.formatSource.isEmpty, "src/lib/format.ts が読めない（リポ同居前提のため fail）")
    }

    @Test func matchStateSymbolParity() {
        let expected = Self.caseReturns(function: "matchStateSymbol")
        #expect(expected.count == 4, "matchStateSymbol は 4 case のはず（実測 \(expected.count)）")
        for state in MatchState.allCases {
            #expect(Format.matchStateSymbol(state) == expected[state.rawValue],
                    "matchStateSymbol(\(state.rawValue)) 不一致")
        }
        // 明示照合（○△×? の取り違え防止）
        #expect(Format.matchStateSymbol(.match) == "○")
        #expect(Format.matchStateSymbol(.partial) == "△")
        #expect(Format.matchStateSymbol(.mismatch) == "×")
        #expect(Format.matchStateSymbol(.unknown) == "?")
    }

    @Test func matchStateAccessibilityLabelParity() {
        let expected = Self.caseReturns(function: "matchStateAccessibilityLabel")
        #expect(expected.count == 4)
        for state in MatchState.allCases {
            #expect(Format.matchStateAccessibilityLabel(state) == expected[state.rawValue])
        }
    }

    @Test func matchStateColorParity() {
        // format.ts: success / warning / danger / textTertiary
        #expect(Format.matchStateColor(.match) == DesignTokens.Colors.success)
        #expect(Format.matchStateColor(.partial) == DesignTokens.Colors.warning)
        #expect(Format.matchStateColor(.mismatch) == DesignTokens.Colors.danger)
        #expect(Format.matchStateColor(.unknown) == DesignTokens.Colors.textTertiary)
    }

    @Test func statusOrderParity() throws {
        let block = try #require(
            DesignTokensParityTests.slice(Self.formatSource, from: "export const statusOrder: InvestigationStatus[] = [", to: "];"),
            "format.ts の statusOrder が見つからない"
        )
        let expected = DesignTokensParityTests.matches(#"'(\w+)'"#, in: block).map { $0[0] }
        #expect(expected.count == 7)
        #expect(Format.statusOrder.map(\.rawValue) == expected)
    }

    @Test func statusLabelParity() {
        let expected = Self.caseReturns(function: "statusLabel")
        #expect(expected.count == 9, "statusLabel は 9 case のはず（実測 \(expected.count)）")
        for status in InvestigationStatus.allCases {
            #expect(Format.statusLabel(status) == expected[status.rawValue],
                    "statusLabel(\(status.rawValue)) 不一致")
        }
    }

    @Test func statusSymbolLogicParity() {
        // format.ts L79-87: 完了済=✓ / 現在=●（complete のみ ✓）/ 未来=○ / failed=!
        #expect(Format.statusSymbol(.parsing, current: .searching) == "✓")
        #expect(Format.statusSymbol(.searching, current: .searching) == "●")
        #expect(Format.statusSymbol(.ranking, current: .searching) == "○")
        #expect(Format.statusSymbol(.complete, current: .complete) == "✓")
        #expect(Format.statusSymbol(.failed, current: .searching) == "!")
    }

    @Test func voteSymbolParity() {
        // format.ts voteSymbol: 1=👍 / 0=🤔 / -1=👎（数値 case のため個別パース）
        guard let fn = DesignTokensParityTests.slice(Self.formatSource, from: "export function voteSymbol", to: "\n}") else {
            Issue.record("format.ts の voteSymbol が見つからない")
            return
        }
        var expected: [Int: String] = [:]
        for match in DesignTokensParityTests.matches(#"case (-?\d+):\s*return '([^']*)';"#, in: fn) {
            expected[Int(match[0]) ?? 99] = match[1]
        }
        #expect(expected.count == 3)
        for value in VoteValue.allCases {
            #expect(Format.voteSymbol(value) == expected[value.rawValue],
                    "voteSymbol(\(value.rawValue)) 不一致")
        }
    }

    @Test func percentParity() {
        // format.ts percent: Math.round(value * 100) + '%'
        #expect(Format.percent(0.91) == "91%")
        #expect(Format.percent(0.125) == "13%")  // JS Math.round(12.5) = 13
        #expect(Format.percent(0) == "0%")
        #expect(Format.percent(1) == "100%")
    }

    @Test func providerFactoryModeRules() {
        // web api.ts の意味論（計画書 §2.7）
        // 明示 mock + debug → mock
        #expect(ProviderFactory.decideMode(explicitMode: "mock", isDebugBuild: true, allowMockInRelease: false) == .mock)
        // 明示 live → live
        #expect(ProviderFactory.decideMode(explicitMode: "live", isDebugBuild: true, allowMockInRelease: false) == .live)
        // 未指定 + debug → mock
        #expect(ProviderFactory.decideMode(explicitMode: nil, isDebugBuild: true, allowMockInRelease: false) == .mock)
        // 未指定 + release → live
        #expect(ProviderFactory.decideMode(explicitMode: nil, isDebugBuild: false, allowMockInRelease: false) == .live)
        // 明示 mock + release（許可なし）→ live（Production never falls back to mock）
        #expect(ProviderFactory.decideMode(explicitMode: "mock", isDebugBuild: false, allowMockInRelease: false) == .live)
        // 明示 mock + release + 許可 → mock（CI 検証用）
        #expect(ProviderFactory.decideMode(explicitMode: "mock", isDebugBuild: false, allowMockInRelease: true) == .mock)
    }
}
