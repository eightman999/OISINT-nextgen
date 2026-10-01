package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.format.Format
import com.oisint.android.model.VoteValue

/** VoteButtons.tsx L13-17 options（value 逐語。ラベルは string resource） */
private data class VoteOption(val value: VoteValue, @StringRes val label: Int)

private val VOTE_OPTIONS = listOf(
    VoteOption(1, R.string.vote_want),
    VoteOption(0, R.string.vote_either),
    VoteOption(-1, R.string.vote_dont_want),
)

/**
 * 投票 3 ボタン。正典は src/components/VoteButtons.tsx。
 *
 * レイアウト移植（VoteButtons.tsx styles）:
 * - container L46-49: Row・gap 8。各ボタン flex 1（等幅）
 * - button L50-59: 中央揃え・gap 4 / paddingVertical 10 / radius sm /
 *   非アクティブ: bg chipBg / border 1 borderSoft
 * - activeButton L60-63: bg orange / border orange
 * - symbol L64-66: 絵文字 20sp（Format.voteSymbol）。label L67-71: 12sp '600' textSecondary
 * - activeText L72-74: surface
 * - a11y（L26-28）: accessibilityLabel = ラベル / accessibilityState selected
 */
@Composable
fun VoteButtons(current: VoteValue?, onVote: (VoteValue) -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(DesignTokens.Radius.sm)
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        VOTE_OPTIONS.forEach { option ->
            val active = current == option.value
            val label = stringResource(option.label)
            Column(
                modifier = Modifier
                    .weight(1f)
                    .semantics {
                        contentDescription = label
                        selected = active
                    }
                    .clip(shape)
                    .background(if (active) DesignTokens.Colors.orange else DesignTokens.Colors.chipBg)
                    .border(
                        1.dp,
                        if (active) DesignTokens.Colors.orange else DesignTokens.Colors.borderSoft,
                        shape,
                    )
                    .clickable(role = Role.Button) { onVote(option.value) }
                    .padding(vertical = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // RN styles.symbol は色指定なし（絵文字グリフ）。アクティブ時のみ activeText
                Text(
                    Format.voteSymbol(option.value),
                    fontSize = 20.sp,
                    color = if (active) DesignTokens.Colors.surface else DesignTokens.Colors.text,
                )
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (active) DesignTokens.Colors.surface else DesignTokens.Colors.textSecondary,
                )
            }
        }
    }
}
