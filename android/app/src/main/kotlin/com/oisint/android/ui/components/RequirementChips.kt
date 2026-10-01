package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.model.Requirement

/**
 * 条件チップ一覧。正典は src/components/RequirementList.tsx。
 *
 * レイアウト移植（RequirementList.tsx styles）:
 * - container L37-39: 縦積み gap 8
 * - heading L40-45: 「条件」16sp Bold text 色 / marginBottom 2
 * - chipRow L46-50: 折り返し Row・gap 7
 * - chip L51-60: minHeight 28 / padding v5 h12 / border 1 borderSoft / radius pill / chipBg
 * - chipText L61-65: 12sp / '600' / textSecondary。表示は req.normalizedText（L18）
 * - addChip L66-77: 同寸・背景と border なし。「＋ 条件を追加」12sp '600' orange。
 *   accessibilityLabel "条件を追加"（L24）
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RequirementChips(
    requirements: List<Requirement>,
    onAddClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pill = RoundedCornerShape(DesignTokens.Radius.pill)
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(R.string.requirements_title),
            modifier = Modifier.padding(bottom = 2.dp),
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.text,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            requirements.forEach { requirement ->
                Box(
                    modifier = Modifier
                        .defaultMinSize(minHeight = 28.dp)
                        .background(DesignTokens.Colors.chipBg, pill)
                        .border(1.dp, DesignTokens.Colors.borderSoft, pill)
                        .padding(vertical = 5.dp, horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        requirement.normalizedText,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = DesignTokens.Colors.textSecondary,
                    )
                }
            }
            val addDescription = stringResource(R.string.requirements_add_a11y)
            Box(
                modifier = Modifier
                    .semantics { contentDescription = addDescription }
                    .clip(pill)
                    .clickable(role = Role.Button, onClick = onAddClick)
                    .defaultMinSize(minHeight = 28.dp)
                    .padding(vertical = 5.dp, horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.requirements_add),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = DesignTokens.Colors.orange,
                )
            }
        }
    }
}
