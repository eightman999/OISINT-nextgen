package com.oisint.android.format

import com.oisint.android.R
import androidx.annotation.StringRes
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

    /** format.ts L32-44（TalkBack 用ラベル。日本語は values/strings.xml に逐語で保持） */
    @StringRes
    fun matchStateAccessibilityLabel(state: MatchState): Int = when (state) {
        MatchState.Match -> R.string.match_state_match
        MatchState.Partial -> R.string.match_state_partial
        MatchState.Mismatch -> R.string.match_state_mismatch
        MatchState.Unknown -> R.string.match_state_unknown
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

    /** format.ts L56-77（日本語は values/strings.xml に逐語で保持） */
    @StringRes
    fun statusLabel(status: InvestigationStatus): Int = when (status) {
        InvestigationStatus.Draft -> R.string.status_draft
        InvestigationStatus.Parsing -> R.string.status_parsing
        InvestigationStatus.Recalling -> R.string.status_recalling
        InvestigationStatus.Searching -> R.string.status_searching
        InvestigationStatus.CollectingEvidence -> R.string.status_collecting_evidence
        InvestigationStatus.Evaluating -> R.string.status_evaluating
        InvestigationStatus.Ranking -> R.string.status_ranking
        InvestigationStatus.Complete -> R.string.status_complete
        InvestigationStatus.Failed -> R.string.status_failed
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
