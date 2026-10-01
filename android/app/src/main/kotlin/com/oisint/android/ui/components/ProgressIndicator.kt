package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.format.Format
import com.oisint.android.model.InvestigationStatus

/**
 * 調査進捗の 7 ステップ表示。正典は src/components/ProgressIndicator.tsx。
 *
 * レイアウト移植（ProgressIndicator.tsx styles）:
 * - container L32-37: 折り返し Row・gap 8 / paddingVertical 12（testID "progress-steps"）
 * - step L38-48: chipBg / border 1 borderSoft / radius pill / padding v4 h10 / gap 4
 * - symbol・label L49-55: fontSize 12。現在 step の label は orange・Bold（L56-59）
 *
 * status == Failed のとき: Web 実装に failed 専用チップは無い。Failed は statusOrder に
 * 含まれないため Format.statusSymbol が全 step "○" を返し、強調も付かない（実装を正とする）。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProgressIndicator(status: InvestigationStatus, modifier: Modifier = Modifier) {
    val pill = RoundedCornerShape(DesignTokens.Radius.pill)
    val progressDescription = stringResource(R.string.progress_a11y, stringResource(Format.statusLabel(status)))
    FlowRow(
        modifier = modifier
            .testTag("progress-steps")
            // ProgressIndicator.tsx L15-16: accessibilityLiveRegion="polite" + 全体ラベル
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = progressDescription
            }
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Format.statusOrder.forEach { step ->
            val active = step == status
            Row(
                modifier = Modifier
                    .background(DesignTokens.Colors.chipBg, pill)
                    .border(1.dp, DesignTokens.Colors.borderSoft, pill)
                    .padding(vertical = 4.dp, horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // RN styles.symbol は色指定なし（デフォルト黒）。トークンの text で固定する
                Text(
                    Format.statusSymbol(step, status),
                    fontSize = 12.sp,
                    color = DesignTokens.Colors.text,
                )
                Text(
                    stringResource(Format.statusLabel(step)),
                    fontSize = 12.sp,
                    fontWeight = if (active) FontWeight.Bold else null,
                    color = if (active) DesignTokens.Colors.orange else DesignTokens.Colors.textSecondary,
                )
            }
        }
    }
}
