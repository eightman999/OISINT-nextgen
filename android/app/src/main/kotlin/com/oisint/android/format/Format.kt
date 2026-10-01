package com.oisint.android.format

import androidx.compose.ui.graphics.Color
import com.oisint.android.design.DesignTokens
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.MatchState
import com.oisint.android.model.VoteValue
import kotlin.math.roundToInt

/** 表示規約。正典は `src/lib/format.ts`（1:1 移植。記号・日本語ラベル・%表示を保存）。 */
object Format {

    /** format.ts L4-16 */
    fun matchStateSymbol(state: MatchState): String = when (state) {
        MatchState.Match -> "○"
        MatchState.Partial -> "△"
        MatchState.Mismatch -> "×"
        MatchState.Unknown -> "?"
    }

    /** format.ts L18-30 */
    fun matchStateColor(state: MatchState): Color = when (state) {
        MatchState.Match -> DesignTokens.Colors.success
        MatchState.Partial -> DesignTokens.Colors.warning
        MatchState.Mismatch -> DesignTokens.Colors.danger
        MatchState.Unknown -> DesignTokens.Colors.textTertiary
    }

    /** format.ts L32-44（TalkBack 用日本語逐語） */
    fun matchStateAccessibilityLabel(state: MatchState): String = when (state) {
        MatchState.Match -> "条件を満たす"
        MatchState.Partial -> "一部満たす"
        MatchState.Mismatch -> "条件を満たさない"
        MatchState.Unknown -> "判定不明"
    }

    /** format.ts L46-54（7 ステップ。draft / failed は含まない） */
    val statusOrder: List<InvestigationStatus> = listOf(
        InvestigationStatus.Parsing,
        InvestigationStatus.Recalling,
        InvestigationStatus.Searching,
        InvestigationStatus.CollectingEvidence,
        InvestigationStatus.Evaluating,
        InvestigationStatus.Ranking,
        InvestigationStatus.Complete,
    )

    /** format.ts L56-77 */
    fun statusLabel(status: InvestigationStatus): String = when (status) {
        InvestigationStatus.Draft -> "下書き"
        InvestigationStatus.Parsing -> "条件解析"
        InvestigationStatus.Recalling -> "類似調査の確認"
        InvestigationStatus.Searching -> "候補店探索"
        InvestigationStatus.CollectingEvidence -> "Evidence収集"
        InvestigationStatus.Evaluating -> "条件評価"
        InvestigationStatus.Ranking -> "ランキング"
        InvestigationStatus.Complete -> "完了"
        InvestigationStatus.Failed -> "失敗"
    }

    /** format.ts L79-87（✓ 済 / ● 現在 / ○ 未 / ! failed） */
    fun statusSymbol(status: InvestigationStatus, current: InvestigationStatus): String {
        val currentIndex = statusOrder.indexOf(current)
        val stepIndex = statusOrder.indexOf(status)

        if (status == InvestigationStatus.Failed) return "!"
        if (stepIndex < currentIndex) return "✓"
        if (stepIndex == currentIndex) {
            return if (status == InvestigationStatus.Complete) "✓" else "●"
        }
        return "○"
    }

    /** format.ts L89-98 */
    fun voteSymbol(value: VoteValue): String = when {
        value > 0 -> "👍"
        value < 0 -> "👎"
        else -> "🤔"
    }

    /** format.ts L100-102: Math.round(value * 100) + '%' */
    fun percent(value: Double): String = "${(value * 100).roundToInt()}%"
}
