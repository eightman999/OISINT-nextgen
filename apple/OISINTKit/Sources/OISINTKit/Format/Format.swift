import Foundation

/// src/lib/format.ts の逐語移植（表示文言の正典。計画書 §1.6）。
/// 記号・日本語ラベルを勝手に言い換えない。FormatParityTests が format.ts と突合する。
public enum Format {
    /// matchStateSymbol: match=○ / partial=△ / mismatch=× / unknown=?
    public static func matchStateSymbol(_ state: MatchState) -> String {
        switch state {
        case .match: return "○"
        case .partial: return "△"
        case .mismatch: return "×"
        case .unknown: return "?"
        }
    }

    /// matchStateColor: success / warning / danger / textTertiary
    public static func matchStateColor(_ state: MatchState) -> ColorToken {
        switch state {
        case .match: return DesignTokens.Colors.success
        case .partial: return DesignTokens.Colors.warning
        case .mismatch: return DesignTokens.Colors.danger
        case .unknown: return DesignTokens.Colors.textTertiary
        }
    }

    /// matchStateAccessibilityLabel（逐語）
    public static func matchStateAccessibilityLabel(_ state: MatchState) -> String {
        switch state {
        case .match: return "条件を満たす"
        case .partial: return "一部満たす"
        case .mismatch: return "条件を満たさない"
        case .unknown: return "判定不明"
        }
    }

    /// 表示用: matchStateAccessibilityLabel の日本語正典をキーに、端末/アプリの言語へ解決する。
    /// 正典（上の関数）は format.ts との突合対象なので変更しない。
    public static func localizedMatchStateAccessibilityLabel(_ state: MatchState) -> String {
        String(localized: String.LocalizationValue(matchStateAccessibilityLabel(state)), bundle: .module)
    }

    /// statusOrder（format.ts L46-54 逐語）
    public static let statusOrder: [InvestigationStatus] = [
        .parsing,
        .recalling,
        .searching,
        .collectingEvidence,
        .evaluating,
        .ranking,
        .complete,
    ]

    /// statusLabel（逐語）
    public static func statusLabel(_ status: InvestigationStatus) -> String {
        switch status {
        case .draft: return "下書き"
        case .parsing: return "条件解析"
        case .recalling: return "類似調査の確認"
        case .searching: return "候補店探索"
        case .collectingEvidence: return "Evidence収集"
        case .evaluating: return "条件評価"
        case .ranking: return "ランキング"
        case .complete: return "完了"
        case .failed: return "失敗"
        }
    }

    /// 表示用: statusLabel の日本語正典をキーに、端末/アプリの言語へ解決する。
    public static func localizedStatusLabel(_ status: InvestigationStatus) -> String {
        String(localized: String.LocalizationValue(statusLabel(status)), bundle: .module)
    }

    /// statusSymbol（format.ts L79-87 のロジック同値移植）
    public static func statusSymbol(_ status: InvestigationStatus, current: InvestigationStatus) -> String {
        let currentIndex = statusOrder.firstIndex(of: current) ?? -1
        let stepIndex = statusOrder.firstIndex(of: status) ?? -1

        if status == .failed { return "!" }
        if stepIndex < currentIndex { return "✓" }
        if stepIndex == currentIndex { return status == .complete ? "✓" : "●" }
        return "○"
    }

    /// voteSymbol: 1=👍 / 0=🤔 / -1=👎
    public static func voteSymbol(_ value: VoteValue) -> String {
        switch value {
        case .up: return "👍"
        case .neutral: return "🤔"
        case .down: return "👎"
        }
    }

    /// percent: Math.round(value * 100) + '%'
    public static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded(.toNearestOrAwayFromZero)))%"
    }
}
