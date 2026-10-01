package com.oisint.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.design.ManropeFamily
import com.oisint.android.format.Format
import com.oisint.android.model.Investigation
import com.oisint.android.model.MatchState

/**
 * 画面下部の 3 パネル（比較 / みんなの投票 / Evidence）。
 * 正典は `src/components/BottomPanels.tsx`（278 行。design.html .bottom-grid）と
 * 呼び出し元 `app/investigations/[id].tsx` L290-308（candidates / evidence の受け渡し）。
 * Web props（candidates / requirements / evidence）は Investigation から導出する。
 */

@Composable
fun ComparisonPanel(investigation: Investigation, modifier: Modifier = Modifier) {
    // Web 呼び出し元は investigation.candidates をそのまま渡す（[id].tsx L292-295。
    // live/mock とも取得時点で rank 昇順ソート済み）
    val candidates = investigation.candidates

    Panel(title = "比較", modifier = modifier) {
        // tsx L23-30 ヘッダ行: 先頭は空セル + 候補名
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .bottomBorder(DesignTokens.Colors.borderSoft, 1.dp)
                .padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // tsx L24: tableHeadCell + tableLabelCell（flex 1.4 / 左寄せ）の空 Text
            Text(
                text = "",
                modifier = Modifier.weight(1.4f),
                color = DesignTokens.Colors.textSecondary,
                fontSize = 9.sp,
                fontWeight = FontWeight.W700,
                textAlign = TextAlign.Left,
            )
            candidates.forEach { candidate ->
                // tsx styles.tableHeadCell: flex 1 / 9sp / 700 / textSecondary / 中央 / 1 行
                Text(
                    text = candidate.place.name,
                    modifier = Modifier.weight(1f),
                    color = DesignTokens.Colors.textSecondary,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.W700,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // tsx L31-52 データ行: 行 = requirement、セル = 各候補の判定記号
        investigation.requirements.forEach { requirement ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .bottomBorder(DesignTokens.Colors.borderSoft, 1.dp)
                    .padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // tsx L34: requirement.text。9sp / text / 左 / 1 行
                Text(
                    text = requirement.text,
                    modifier = Modifier.weight(1.4f),
                    color = DesignTokens.Colors.text,
                    fontSize = 9.sp,
                    textAlign = TextAlign.Left,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                candidates.forEach { candidate ->
                    // tsx L37-40: state = 該当評価が無ければ 'unknown'
                    val state = candidate.evaluations
                        .firstOrNull { it.requirementId == requirement.id }
                        ?.state ?: MatchState.Unknown
                    // tsx styles.tableMatch: 11sp / 800 / fonts.brand（Manrope）+ 状態色。
                    // TalkBack へは記号でなく日本語ラベル（tsx L43）
                    Text(
                        text = Format.matchStateSymbol(state),
                        modifier = Modifier
                            .weight(1f)
                            .clearAndSetSemantics {
                                contentDescription = Format.matchStateAccessibilityLabel(state)
                            },
                        color = Format.matchStateColor(state),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.W800,
                        fontFamily = ManropeFamily,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
fun VotePanel(
    investigation: Investigation,
    onVotePress: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    // tsx L64: [...candidates].sort((a, b) => a.rank - b.rank)
    val sorted = investigation.candidates.sortedBy { it.rank }

    Panel(title = "みんなの投票", modifier = modifier) {
        // tsx styles.voteList: gap 7
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            sorted.forEach { candidate ->
                // tsx L71-73: upVotes = votes の値のうち 1 の個数
                val upVotes = candidate.votes.values.count { it == 1 }
                // tsx styles.voteItem: minHeight 36 / paddingV 6 paddingH 8 / 枠 borderSoft /
                // radius 7 / row / 中央 / gap 7
                val itemShape = RoundedCornerShape(7.dp)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 36.dp)
                        .clip(itemShape)
                        .border(1.dp, DesignTokens.Colors.borderSoft, itemShape)
                        .padding(vertical = 6.dp, horizontal = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // tsx styles.voteRank: 幅 20 / 800 / 12sp / text / fonts.brand（Manrope）
                    Text(
                        text = "${candidate.rank}",
                        modifier = Modifier.width(20.dp),
                        color = DesignTokens.Colors.text,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.W800,
                        fontFamily = ManropeFamily,
                    )
                    // tsx styles.voteName: flex 1 / 10sp / 700 / text / 1 行
                    Text(
                        text = candidate.place.name,
                        modifier = Modifier.weight(1f),
                        color = DesignTokens.Colors.text,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.W700,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // tsx L80 styles.voteCount: `{upVotes}票`（10sp / textSecondary）
                    Text(
                        text = "${upVotes}票",
                        color = DesignTokens.Colors.textSecondary,
                        fontSize = 10.sp,
                    )
                }
            }
        }
        // tsx L85-94: onVotePress があるときのみ、一覧の下に単一の「投票する」ボタン。
        // voteButton: minHeight 38 / radius 7 / bg orange / marginTop 10、文字 12sp / 700 / 白
        if (onVotePress != null) {
            val buttonShape = RoundedCornerShape(7.dp)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp)
                    .heightIn(min = 38.dp)
                    .clip(buttonShape)
                    .background(DesignTokens.Colors.orange)
                    .clickable(onClickLabel = "候補に投票する") { onVotePress() },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "投票する",
                    color = DesignTokens.Colors.surface,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.W700,
                )
            }
        }
    }
}

@Composable
fun EvidencePanel(investigation: Investigation, modifier: Modifier = Modifier) {
    // Web 呼び出し元（[id].tsx L305）: candidates を宣言順に flatMap → パネル側で先頭 4 件（tsx L111）
    val evidence = investigation.candidates.flatMap { it.evidence }

    Panel(title = "Evidence", modifier = modifier) {
        if (evidence.isEmpty()) {
            // tsx styles.empty: 11sp / textTertiary / italic
            Text(
                text = "Evidenceはまだ収集されていません",
                color = DesignTokens.Colors.textTertiary,
                fontSize = 11.sp,
                fontStyle = FontStyle.Italic,
            )
        } else {
            // tsx styles.evidenceList: gap 6
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                evidence.take(4).forEach { item ->
                    // tsx styles.evidenceItem: minHeight 38 / padding 7 / 枠 borderSoft /
                    // radius 7 / row / 中央 / gap 7
                    val itemShape = RoundedCornerShape(7.dp)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 38.dp)
                            .clip(itemShape)
                            .border(1.dp, DesignTokens.Colors.borderSoft, itemShape)
                            .padding(7.dp),
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // tsx styles.sourceIcon: 22x22 / radius 5 / bg '#f1f1f1'（tsx L247 直書き色）
                        Box(
                            modifier = Modifier
                                .size(22.dp)
                                .clip(RoundedCornerShape(5.dp))
                                .background(Color(0xFFF1F1F1)),
                            contentAlignment = Alignment.Center,
                        ) {
                            // tsx L114-116: (sourceTitle ?? sourceType) の先頭 1 文字。10sp / 700
                            Text(
                                text = (item.sourceTitle ?: item.sourceType).take(1),
                                color = DesignTokens.Colors.textSecondary,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.W700,
                            )
                        }
                        // tsx styles.evidenceBody: flex 1
                        Column(modifier = Modifier.weight(1f)) {
                            // tsx styles.sourceName: 10sp / 700 / text / 1 行
                            Text(
                                text = item.sourceTitle ?: item.sourceType,
                                color = DesignTokens.Colors.text,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.W700,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            // tsx styles.sourceMeta: excerpt。marginTop 2 / 8sp / lineHeight 11 / 2 行
                            Text(
                                text = item.excerpt,
                                modifier = Modifier.padding(top = 2.dp),
                                color = DesignTokens.Colors.textSecondary,
                                fontSize = 8.sp,
                                lineHeight = 11.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        // tsx L126: observedAt.slice(5).replace('-', '/')（最初の '-' のみ置換）
                        // 例 "2026-08-14" → "08/14"。9sp / textTertiary / 右寄せ
                        Text(
                            text = item.observedAt.drop(5).replaceFirst("-", "/"),
                            color = DesignTokens.Colors.textTertiary,
                            fontSize = 9.sp,
                            textAlign = TextAlign.Right,
                        )
                    }
                }
            }
        }
    }
}

/**
 * tsx styles.panel + panelTitle 共通部。
 * panel: minWidth 240 / 枠 1 colors.border / radius 10（theme トークン外の直書き値・tsx L141）/
 * bg surface / padding 12。panelTitle: 13sp / 700 / text / marginBottom 10。
 */
@Composable
private fun Panel(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = modifier
            .widthIn(min = 240.dp)
            .clip(shape)
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.border, shape)
            .padding(12.dp),
    ) {
        Text(
            text = title,
            modifier = Modifier.padding(bottom = 10.dp),
            color = DesignTokens.Colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.W700,
        )
        content()
    }
}

/** RN の borderBottomWidth 相当（レイアウト空間を消費しない下線） */
private fun Modifier.bottomBorder(color: Color, strokeWidth: Dp): Modifier = drawBehind {
    val y = size.height - strokeWidth.toPx() / 2f
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth.toPx())
}
