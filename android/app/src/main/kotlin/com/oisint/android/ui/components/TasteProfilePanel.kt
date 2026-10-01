package com.oisint.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.model.TasteHealthGoal
import com.oisint.android.model.TasteProfile

/** TasteProfilePanel.tsx L12 */
private val LIKE_OPTIONS = listOf("肉", "寿司", "ラーメン", "カフェ", "野菜")

/** TasteProfilePanel.tsx L13 */
private val AVOID_OPTIONS = listOf("辛いもの", "混雑", "騒がしい", "高価格")

/** TasteProfilePanel.tsx L14 */
private val ALLERGY_OPTIONS = listOf("小麦", "乳製品", "卵", "ナッツ")

/** TasteProfilePanel.tsx L15-19（value はモデル enum、label は逐語） */
private val HEALTH_OPTIONS: List<Pair<TasteHealthGoal, String>> = listOf(
    TasteHealthGoal.None to "指定なし",
    TasteHealthGoal.Diet to "ダイエット",
    TasteHealthGoal.HighProtein to "高たんぱく",
)

/** tsx L25-33 toggleListValue: 含まれていれば除去、なければ末尾に追加 */
private fun toggleListValue(current: List<String>, option: String): List<String> =
    if (current.contains(option)) current.filter { it != option } else current + option

/**
 * tsx L35-44 toggleAllergy: allergies（String）を「、」で分割 → trim → 空要素除去した
 * リストに対してトグルし、「、」join で合成し直す。自由入力（taste-allergy-input）は
 * 同じ String を直接編集するため、チップ選択と自由記述が 1 フィールドに共存する。
 */
private fun toggleAllergy(allergies: String, option: String): String {
    val existing = allergies.split("、").map { it.trim() }.filter { it.isNotEmpty() }
    val next = if (existing.contains(option)) existing.filter { it != option } else existing + option
    return next.joinToString("、")
}

/**
 * 好み設定パネル（トグル開閉式）。正典は `src/components/TasteProfilePanel.tsx`（全 292 行）。
 *
 * 文言は tsx 逐語。testTag は Web testID と同名。
 */
@Composable
fun TasteProfilePanel(
    profile: TasteProfile,
    onProfileChange: (TasteProfile) -> Unit,
    modifier: Modifier = Modifier,
) {
    // tsx L22 useState(false)
    var open by rememberSaveable { mutableStateOf(false) }
    // tsx L23: likes 件数 + avoid 件数 + (allergies 非空なら 1)
    val selectedCount =
        profile.likes.size + profile.avoid.size + (if (profile.allergies.isNotEmpty()) 1 else 0)

    // tsx L177-183 container: radius md / border 1 borderSoft / overflow hidden
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DesignTokens.Radius.md))
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(DesignTokens.Radius.md)),
    ) {
        // tsx L48-70 header: クリックで開閉 / row / gap 12 / padding 14
        Row(
            modifier = Modifier
                .testTag("taste-toggle")
                .fillMaxWidth()
                .clickable(role = Role.Button) { open = !open }
                .padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // tsx L56-65 headerCopy: gap 3
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                // tsx L57 eyebrow: 10sp / 800 / letterSpacing 1.2 / orange
                Text(
                    text = "02 / あなたの好み",
                    color = DesignTokens.Colors.orange,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 1.2.sp,
                )
                // tsx L58 title: 15sp / 700 / text
                Text(
                    text = "好みを30秒で設定する",
                    color = DesignTokens.Colors.text,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                )
                // tsx L59-61 description: 11sp / lineHeight 17 / textSecondary
                Text(
                    text = "好き・避けたいは検索条件に、アレルギー・健康目的は候補確認の補助情報として使います。",
                    color = DesignTokens.Colors.textSecondary,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                )
            }
            // tsx L66-69 headerRight: 件数 + シェブロン
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                // tsx L67: >0 なら「{N}件」、0 なら「任意」。色は常に orange（tsx L220-224）
                Text(
                    text = if (selectedCount > 0) "${selectedCount}件" else "任意",
                    color = DesignTokens.Colors.orange,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                )
                // tsx L68 chevron: 20sp / lineHeight 22 / textSecondary
                Text(
                    text = if (open) "⌃" else "⌄",
                    color = DesignTokens.Colors.textSecondary,
                    fontSize = 20.sp,
                    lineHeight = 22.sp,
                )
            }
        }

        if (open) {
            // tsx L234-235 body の borderTop（borderSoft）
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(DesignTokens.Colors.borderSoft),
            )
            // tsx L230-236 body: gap 16 / paddingH 14 / paddingBottom 14（top padding なし）
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // tsx L74: 好きなもの（複数選択トグル）
                TasteChipGroup(
                    label = "好きなもの",
                    options = LIKE_OPTIONS,
                    selected = profile.likes,
                    testPrefix = "taste-like",
                    onToggle = { option ->
                        onProfileChange(profile.copy(likes = toggleListValue(profile.likes, option)))
                    },
                )

                // tsx L75: 避けたいもの（複数選択トグル）
                TasteChipGroup(
                    label = "避けたいもの",
                    options = AVOID_OPTIONS,
                    selected = profile.avoid,
                    testPrefix = "taste-avoid",
                    onToggle = { option ->
                        onProfileChange(profile.copy(avoid = toggleListValue(profile.avoid, option)))
                    },
                )

                // tsx L77-108: アレルギー・食事制限（チップ + 自由入力が同じ String を編集）
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    GroupLabel("アレルギー・食事制限")
                    ChipFlowRow {
                        ALLERGY_OPTIONS.forEach { option ->
                            // tsx L81: 選択判定は trim なしの生 split（toggle 側 L36-39 のみ trim）
                            val active = profile.allergies.split("、").contains(option)
                            TasteChip(
                                label = option,
                                active = active,
                                tag = "taste-allergy-$option",
                                role = Role.Checkbox,
                                onClick = {
                                    onProfileChange(
                                        profile.copy(allergies = toggleAllergy(profile.allergies, option)),
                                    )
                                },
                            )
                        }
                    }
                    // tsx L97-106: value=allergies を直接編集（チップ合成結果もここに表示される）
                    AllergyTextField(
                        value = profile.allergies,
                        onValueChange = { onProfileChange(profile.copy(allergies = it)) },
                    )
                    // tsx L107 safetyNote: 10sp / lineHeight 15 / warning
                    Text(
                        text = "アレルギーは候補の確認条件です。最終的には店舗へ直接確認してください。",
                        color = DesignTokens.Colors.warning,
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                    )
                }

                // tsx L110-131: 健康目的（単一選択）
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    GroupLabel("健康目的")
                    ChipFlowRow {
                        HEALTH_OPTIONS.forEach { (goal, label) ->
                            TasteChip(
                                label = label,
                                active = profile.healthGoal == goal,
                                tag = "taste-health-${goal.wire}",
                                role = Role.RadioButton,
                                onClick = { onProfileChange(profile.copy(healthGoal = goal)) },
                            )
                        }
                    }
                    // tsx L130 futureNote（逐語）: 10sp / lineHeight 15 / textTertiary
                    Text(
                        text = "Appleヘルス / Google Health Connectとの連携はアプリ版で対応予定です。Web版では接続しません。",
                        color = DesignTokens.Colors.textTertiary,
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                    )
                }
            }
        }
    }
}

/** tsx L138-174 TasteRow: グループ見出し + チップ行（複数選択） */
@Composable
private fun TasteChipGroup(
    label: String,
    options: List<String>,
    selected: List<String>,
    testPrefix: String,
    onToggle: (String) -> Unit,
) {
    // tsx L237-239 group: gap 7
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        GroupLabel(label)
        ChipFlowRow {
            options.forEach { option ->
                TasteChip(
                    label = option,
                    active = selected.contains(option),
                    tag = "$testPrefix-$option",
                    role = Role.Checkbox,
                    onClick = { onToggle(option) },
                )
            }
        }
    }
}

/** tsx L240-244 groupLabel: 11sp / 700 / textSecondary */
@Composable
private fun GroupLabel(text: String) {
    Text(
        text = text,
        color = DesignTokens.Colors.textSecondary,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
    )
}

/** tsx L245-249 chipRow: wrap / gap 7 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipFlowRow(content: @Composable () -> Unit) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        content()
    }
}

/**
 * tsx L250-271 chip: minHeight 30 / paddingH 11 / radius pill。
 * 選択中: border orange + bg activeBg + 文字 orange（tsx chipActive / chipTextActive）。
 * 未選択の配色はタスク指定（border border + bg surface。tsx L255-256 は borderSoft / chipBg）。
 */
@Composable
private fun TasteChip(
    label: String,
    active: Boolean,
    tag: String,
    role: Role,
    onClick: () -> Unit,
) {
    val borderColor = if (active) DesignTokens.Colors.orange else DesignTokens.Colors.border
    val backgroundColor = if (active) DesignTokens.Colors.activeBg else DesignTokens.Colors.surface
    Box(
        modifier = Modifier
            .testTag(tag)
            .defaultMinSize(minHeight = 30.dp)
            .clip(RoundedCornerShape(DesignTokens.Radius.pill))
            .background(backgroundColor)
            .border(1.dp, borderColor, RoundedCornerShape(DesignTokens.Radius.pill))
            .clickable(role = role, onClick = onClick)
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        // tsx L263-271 chipText: 11sp / 600（選択中 700 / orange）
        Text(
            text = label,
            color = if (active) DesignTokens.Colors.orange else DesignTokens.Colors.textSecondary,
            fontSize = 11.sp,
            fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold,
        )
    }
}

/** tsx L272-281 textInput: minHeight 38 / paddingH 11 / border / radius sm / 13sp */
@Composable
private fun AllergyTextField(
    value: String,
    onValueChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier
            .testTag("taste-allergy-input")
            .fillMaxWidth()
            .clip(RoundedCornerShape(DesignTokens.Radius.sm))
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.sm)),
        textStyle = TextStyle(
            color = DesignTokens.Colors.text,
            fontSize = 13.sp,
        ),
        cursorBrush = SolidColor(DesignTokens.Colors.text),
        singleLine = true,
        decorationBox = { innerTextField ->
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 38.dp)
                    .padding(horizontal = 11.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) {
                    // tsx L103-104 placeholder / textTertiary
                    Text(
                        text = "その他・補足（例：甲殻類）",
                        color = DesignTokens.Colors.textTertiary,
                        fontSize = 13.sp,
                    )
                }
                innerTextField()
            }
        },
    )
}
