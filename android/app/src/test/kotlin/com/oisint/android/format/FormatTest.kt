package com.oisint.android.format

import com.oisint.android.testing.StringResources
import com.oisint.android.design.DesignTokens
import com.oisint.android.model.InvestigationStatus
import com.oisint.android.model.MatchState
import org.junit.Assert.assertEquals
import org.junit.Test

/** format.ts と同値であることの検証（期待値は src/lib/format.ts L4-102 の逐語）。 */
class FormatTest {

    @Test
    fun statusOrderHasSevenStepsInFormatTsOrder() {
        // format.ts L46-54
        assertEquals(
            listOf(
                InvestigationStatus.Parsing,
                InvestigationStatus.Recalling,
                InvestigationStatus.Searching,
                InvestigationStatus.CollectingEvidence,
                InvestigationStatus.Evaluating,
                InvestigationStatus.Ranking,
                InvestigationStatus.Complete,
            ),
            Format.statusOrder,
        )
        assertEquals(7, Format.statusOrder.size)
    }

    @Test
    fun statusLabelsMatchFormatTs() {
        // format.ts L56-77
        assertEquals("下書き", StringResources.ja(Format.statusLabel(InvestigationStatus.Draft)))
        assertEquals("条件解析", StringResources.ja(Format.statusLabel(InvestigationStatus.Parsing)))
        assertEquals("類似調査の確認", StringResources.ja(Format.statusLabel(InvestigationStatus.Recalling)))
        assertEquals("候補店探索", StringResources.ja(Format.statusLabel(InvestigationStatus.Searching)))
        assertEquals("Evidence収集", StringResources.ja(Format.statusLabel(InvestigationStatus.CollectingEvidence)))
        assertEquals("条件評価", StringResources.ja(Format.statusLabel(InvestigationStatus.Evaluating)))
        assertEquals("ランキング", StringResources.ja(Format.statusLabel(InvestigationStatus.Ranking)))
        assertEquals("完了", StringResources.ja(Format.statusLabel(InvestigationStatus.Complete)))
        assertEquals("失敗", StringResources.ja(Format.statusLabel(InvestigationStatus.Failed)))
    }

    @Test
    fun matchStateSymbolsMatchFormatTs() {
        // format.ts L4-16
        assertEquals("○", Format.matchStateSymbol(MatchState.Match))
        assertEquals("△", Format.matchStateSymbol(MatchState.Partial))
        assertEquals("×", Format.matchStateSymbol(MatchState.Mismatch))
        assertEquals("?", Format.matchStateSymbol(MatchState.Unknown))
    }

    @Test
    fun matchStateColorsMatchFormatTs() {
        // format.ts L18-30（unknown は textTertiary。design.html の #777 ではなくアプリ実装を正とする）
        assertEquals(DesignTokens.Colors.success, Format.matchStateColor(MatchState.Match))
        assertEquals(DesignTokens.Colors.warning, Format.matchStateColor(MatchState.Partial))
        assertEquals(DesignTokens.Colors.danger, Format.matchStateColor(MatchState.Mismatch))
        assertEquals(DesignTokens.Colors.textTertiary, Format.matchStateColor(MatchState.Unknown))
    }

    @Test
    fun matchStateAccessibilityLabelsMatchFormatTs() {
        // format.ts L32-44
        assertEquals("条件を満たす", StringResources.ja(Format.matchStateAccessibilityLabel(MatchState.Match)))
        assertEquals("一部満たす", StringResources.ja(Format.matchStateAccessibilityLabel(MatchState.Partial)))
        assertEquals("条件を満たさない", StringResources.ja(Format.matchStateAccessibilityLabel(MatchState.Mismatch)))
        assertEquals("判定不明", StringResources.ja(Format.matchStateAccessibilityLabel(MatchState.Unknown)))
    }

    @Test
    fun statusSymbolMatchesFormatTs() {
        // format.ts L79-87
        // current=collecting_evidence: 手前 3 步は ✓、現在は ●、先は ○
        val current = InvestigationStatus.CollectingEvidence
        assertEquals("✓", Format.statusSymbol(InvestigationStatus.Parsing, current))
        assertEquals("✓", Format.statusSymbol(InvestigationStatus.Recalling, current))
        assertEquals("✓", Format.statusSymbol(InvestigationStatus.Searching, current))
        assertEquals("●", Format.statusSymbol(InvestigationStatus.CollectingEvidence, current))
        assertEquals("○", Format.statusSymbol(InvestigationStatus.Evaluating, current))
        assertEquals("○", Format.statusSymbol(InvestigationStatus.Ranking, current))
        assertEquals("○", Format.statusSymbol(InvestigationStatus.Complete, current))
        // complete が現在のときは ✓
        assertEquals("✓", Format.statusSymbol(InvestigationStatus.Complete, InvestigationStatus.Complete))
        // failed step は常に !
        assertEquals("!", Format.statusSymbol(InvestigationStatus.Failed, current))
        // current=failed（indexOf=-1）のとき全 step は ○（format.ts の実挙動）
        assertEquals("○", Format.statusSymbol(InvestigationStatus.Parsing, InvestigationStatus.Failed))
    }

    @Test
    fun voteSymbolsMatchFormatTs() {
        // format.ts L89-98
        assertEquals("👍", Format.voteSymbol(1))
        assertEquals("🤔", Format.voteSymbol(0))
        assertEquals("👎", Format.voteSymbol(-1))
    }

    @Test
    fun percentMatchesFormatTs() {
        // format.ts L100-102: Math.round(value * 100) + '%'
        assertEquals("98%", Format.percent(0.98))
        assertEquals("61%", Format.percent(0.61))
        assertEquals("0%", Format.percent(0.0))
        assertEquals("100%", Format.percent(1.0))
        assertEquals("35%", Format.percent(0.35))
    }
}
