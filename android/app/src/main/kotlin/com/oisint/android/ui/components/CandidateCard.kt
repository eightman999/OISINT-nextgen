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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.design.ManropeFamily
import com.oisint.android.format.Format
import com.oisint.android.model.Candidate
import com.oisint.android.model.InvestigationMember
import com.oisint.android.model.MatchState
import com.oisint.android.model.Requirement
import com.oisint.android.model.RequirementPriority

/** CandidateCard.tsx L246 `summary` の逐語リテラル色（theme.ts に無い） */
private val SummaryTextColor = Color(0xFF555D63)

/** CandidateCard.tsx L288 `priceText` の逐語リテラル色（theme.ts に無い） */
private val PriceTextColor = Color(0xFF4E555B)

/** CandidateCard.tsx L37: `/徒歩\d+分/` */
private val WalkRegex = Regex("""徒歩\d+分""")

/**
 * CandidateCard.tsx L33-45 `buildTags`。追加順を保存:
 * 徒歩◯分(Blue) → 予算(Green) → カード可(Orange) → 矛盾(Red)。
 * `if (place.budget)` は truthy 判定のため isNullOrEmpty で移植。
 */
private fun buildTags(candidate: Candidate): List<Pair<String, TagTone>> {
    val place = candidate.place
    return buildList {
        val walk = place.access?.let { WalkRegex.find(it)?.value }
        if (walk != null) add(walk to TagTone.Blue)
        if (!place.budget.isNullOrEmpty()) add("予算 ${place.budget}" to TagTone.Green)
        if (place.card == "可") add("カード可" to TagTone.Orange)
        if (candidate.contradictions.isNotEmpty()) {
            add("⚠ 矛盾${candidate.contradictions.size}件" to TagTone.Red)
        }
    }
}

/** RN の borderTopWidth: 1 相当（CandidateCard.tsx L261-262 / L283-284） */
private fun Modifier.topBorder(color: Color): Modifier = drawBehind {
    val strokeWidth = 1.dp.toPx()
    drawLine(
        color = color,
        start = Offset(0f, strokeWidth / 2f),
        end = Offset(size.width, strokeWidth / 2f),
        strokeWidth = strokeWidth,
    )
}

/**
 * 候補カード。正典は `src/components/CandidateCard.tsx`（全 305 行の 1:1 移植）。
 * - 文言・testTag（Web の testID と同名）・StyleSheet 数値（dp/sp 1:1）を保存。
 * - 上部色面は tsx L88-93 どおり画像を描画せず、genreColor 背景 + ジャンル名テキストのみ。
 * - tsx L182 の boxShadow(0 2px 7px rgba(30,26,22,0.04)) は Compose に等価表現が無いため未移植。
 * - ○△×? 評価列は requirements の並び順で描画し、評価が無い requirement は unknown("?") 扱い
 *   （tsx L133-152 は evaluations 起点だが、Kotlin 版は requirements が必須引数のため正規化）。
 * - 投票記号は tsx L164 の `value === 1 ? '👍' : '👎'` と等価な Format.voteSymbol を使用
 *   （value != 0 でフィルタ済みのため結果は逐語一致）。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CandidateCard(
    candidate: Candidate,
    requirements: List<Requirement>,
    members: List<InvestigationMember>,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val place = candidate.place

    // tsx L54-60: value != 0 の投票のみ。表示名は members から id 一致で解決（無ければ '不明'）
    val voteDisplay = candidate.votes.entries
        .filter { it.value != 0 }
        .map { (userId, value) ->
            val member = members.firstOrNull { it.id == userId }
            (member?.displayName ?: "不明") to value
        }

    val tags = buildTags(candidate)

    // tsx L65-68: total = requirements.length（Kotlin 版は必須引数のため ?? 分岐なし）、
    // matched = evaluations のうち state === 'match' の数
    val totalRequirements = requirements.size
    val matchedRequirements = candidate.evaluations.count { it.state == MatchState.Match }

    // must の不足・不適合を別々に保持する。#312 の推薦抑止は unknown/評価欠落だけを対象にし、
    // mismatch は従来どおり hard penalty と「不適合」表示で扱う。
    val missingMustRequirements = requirements
        .filter { it.priority == RequirementPriority.Must }
        .filter { requirement ->
            val evaluation = candidate.evaluations.firstOrNull { it.requirementId == requirement.id }
            evaluation == null ||
                evaluation.state == MatchState.Mismatch ||
                evaluation.state == MatchState.Unknown
        }
    val unresolvedMustRequirements = requirements
        .filter { it.priority == RequirementPriority.Must }
        .filter { requirement ->
            val evaluation = candidate.evaluations.firstOrNull { it.requirementId == requirement.id }
            evaluation == null || evaluation.state == MatchState.Unknown
        }
    val mismatchedMustRequirements = requirements
        .filter { it.priority == RequirementPriority.Must }
        .filter { requirement ->
            candidate.evaluations.any {
                it.requirementId == requirement.id && it.state == MatchState.Mismatch
            }
        }
    val suppressRecommendationEmphasis =
        candidate.rank == 1 && unresolvedMustRequirements.isNotEmpty()

    val shape = RoundedCornerShape(DesignTokens.Radius.sm)
    val cardLabel = buildString {
        append("候補${candidate.rank}位 ${place.name}")
        if (suppressRecommendationEmphasis) {
            append("。必須条件に未確認項目があるためおすすめ未確定です")
        }
        append("。候補の詳細を表示")
    }

    // tsx L78-93 container: surface 背景 / border 1（selected 時 orange 2）/ radius.sm / overflow hidden
    Column(
        modifier = modifier
            .testTag("inv-candidate-${candidate.rank}")
            .clip(shape)
            .background(DesignTokens.Colors.surface)
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = if (selected) DesignTokens.Colors.orange else DesignTokens.Colors.border,
                shape = shape,
            )
            .clickable(
                onClickLabel = "タップすると条件適合度と根拠を確認できます",
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = cardLabel },
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1.8f)
                .background(DesignTokens.genreColor(place.genre)),
        ) {
            Text(
                text = place.genre ?: "グルメ",
                color = DesignTokens.Colors.surface,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(8.dp),
            )

            if (suppressRecommendationEmphasis) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .testTag("inv-rank-unverified-${candidate.rank}")
                        .background(
                            color = DesignTokens.Colors.warningSoft,
                            shape = RoundedCornerShape(0.dp, 0.dp, 8.dp, 0.dp),
                        )
                        .padding(horizontal = 9.dp, vertical = 6.dp)
                        .semantics {
                            contentDescription =
                                "1位候補ですが、必須条件が未確認のためおすすめ未確定です"
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "調査不足",
                        color = DesignTokens.Colors.warning,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.ExtraBold,
                        fontFamily = ManropeFamily,
                    )
                }
            } else {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .size(27.dp)
                        .testTag("inv-rank-${candidate.rank}")
                        .background(
                            color = DesignTokens.rankColor(candidate.rank),
                            shape = RoundedCornerShape(0.dp, 0.dp, 8.dp, 0.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = candidate.rank.toString(),
                        color = DesignTokens.Colors.surface,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.ExtraBold,
                        fontFamily = ManropeFamily,
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = place.name,
                color = DesignTokens.Colors.text,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 19.sp,
            )

            Text(
                text = place.genre.orEmpty() + "\n" + place.access.orEmpty(),
                color = DesignTokens.Colors.textSecondary,
                fontSize = 10.sp,
                lineHeight = 15.sp,
            )

            val fillText = "条件 $matchedRequirements/${totalRequirements}件が一致"
            Text(
                text = fillText,
                color = DesignTokens.Colors.textSecondary,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .testTag("inv-fill-${candidate.rank}")
                    .semantics { contentDescription = fillText },
            )

            if (suppressRecommendationEmphasis) {
                Text(
                    text = "未確認の必須条件あり: ${unresolvedMustRequirements.joinToString("、") { it.normalizedText }}",
                    color = DesignTokens.Colors.warning,
                    fontSize = 10.sp,
                    lineHeight = 15.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("inv-gap-${candidate.rank}")
                        .background(
                            DesignTokens.Colors.warningSoft,
                            RoundedCornerShape(DesignTokens.Radius.sm),
                        )
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
                if (mismatchedMustRequirements.isNotEmpty()) {
                    Text(
                        text = "不適合の必須条件: ${mismatchedMustRequirements.joinToString("、") { it.normalizedText }}",
                        color = DesignTokens.Colors.warning,
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("inv-mismatch-${candidate.rank}")
                            .background(
                                DesignTokens.Colors.warningSoft,
                                RoundedCornerShape(DesignTokens.Radius.sm),
                            )
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    )
                }
            } else if (missingMustRequirements.isNotEmpty()) {
                Text(
                    text = "要確認: ${missingMustRequirements.joinToString("、") { it.normalizedText }}",
                    color = DesignTokens.Colors.warning,
                    fontSize = 10.sp,
                    lineHeight = 15.sp,
                    modifier = Modifier.testTag("inv-gap-${candidate.rank}"),
                )
            }

            if (tags.isNotEmpty()) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    tags.forEach { (label, tone) ->
                        OisintTag(text = label, tone = tone)
                    }
                }
            }

            if (!place.open.isNullOrEmpty() || !place.close.isNullOrEmpty()) {
                Text(
                    text = "営業 ${place.open ?: "?"}〜${place.close ?: "?"}",
                    color = SummaryTextColor,
                    fontSize = 10.sp,
                    lineHeight = 15.sp,
                )
            }

            if (requirements.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .topBorder(DesignTokens.Colors.borderSoft)
                        .padding(top = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    requirements.forEach { requirement ->
                        val state = candidate.evaluations
                            .firstOrNull { it.requirementId == requirement.id }
                            ?.state
                            ?: MatchState.Unknown
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = requirement.normalizedText,
                                color = DesignTokens.Colors.textSecondary,
                                fontSize = 10.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            val stateLabel = Format.matchStateAccessibilityLabel(state)
                            Text(
                                text = Format.matchStateSymbol(state),
                                color = Format.matchStateColor(state),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.ExtraBold,
                                fontFamily = ManropeFamily,
                                modifier = Modifier.semantics { contentDescription = stateLabel },
                            )
                        }
                    }
                }
            }

            if (!place.budget.isNullOrEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .topBorder(DesignTokens.Colors.borderSoft)
                        .padding(top = 8.dp),
                ) {
                    Text(
                        text = "予算目安　${place.budget} / 人",
                        color = PriceTextColor,
                        fontSize = 10.sp,
                    )
                }
            }

            if (voteDisplay.isNotEmpty()) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    voteDisplay.forEach { (name, value) ->
                        Text(
                            text = "$name: ${Format.voteSymbol(value)}",
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 10.sp,
                            modifier = Modifier
                                .clip(RoundedCornerShape(DesignTokens.Radius.pill))
                                .background(DesignTokens.Colors.surfaceSoft)
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}
