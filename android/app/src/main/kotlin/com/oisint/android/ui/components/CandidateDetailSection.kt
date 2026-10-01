package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalConfiguration
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import com.oisint.android.design.DesignTokens
import com.oisint.android.format.DecisionText
import com.oisint.android.format.Format
import com.oisint.android.model.Candidate
import com.oisint.android.model.Evidence
import com.oisint.android.model.Investigation
import com.oisint.android.model.RequirementKind
import com.oisint.android.model.VoteValue
import java.net.URI
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** CandidateDetail.tsx L30 `useState<'short' | 'detailed' | null>` の 2 値 */
private enum class DecisionFormat { Short, Detailed }

/**
 * 候補詳細。正典は `src/components/CandidateDetail.tsx`（417 行の 1:1 移植）。
 *
 * Web との差分（意図的なもののみ）:
 * - Web props の requirements は investigation.requirements として受ける（investigation 非 null）。
 * - コピーは navigator.clipboard の代わりに LocalClipboardManager を使用。Android では
 *   常に成功するため tsx L189-191 の「この環境ではコピーできません…」分岐は移植しない（成功系のみ）。
 * - testTag "decision-text" は tsx L131 ではセクション View に付くが、Android 仕様により
 *   プレビュー Text（tsx L176 styles.decisionPreview）へ付ける。
 */
@Composable
fun CandidateDetailSection(
    investigation: Investigation,
    candidate: Candidate,
    currentVote: VoteValue?,
    onVote: (VoteValue) -> Unit,
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
    currentVoteComment: String? = null,
    onVoteWithComment: ((VoteValue, String?) -> Unit)? = null,
) {
    // tsx L30-31 useState（React 同様、候補切替後も remount されない限り状態は保持）
    var decisionFormat by remember { mutableStateOf<DecisionFormat?>(null) }
    var copied by remember { mutableStateOf(false) }
    // tsx L32-36: 毎レンダー生成 → 同一入力なら同一出力なので remember でキャッシュ
    // 定型文は端末/アプリのロケールの string resource から組み立てる（店舗データ由来の内容は原文）
    val resources = LocalResources.current
    val configuration = LocalConfiguration.current
    val decisionLabels = remember(resources, configuration) {
        DecisionText.Labels.from(resources::getString)
    }
    val decisionText = remember(investigation, candidate, decisionLabels) {
        DecisionText.generateDecisionText(
            investigation,
            candidate,
            decisionLabels,
            DecisionText.Options(mapUrl = mapUrlFor(candidate)),
        )
    }
    val unknownMemberName = stringResource(R.string.common_unknown)
    val unknownSource = stringResource(R.string.decision_unknown_source)
    val clipboardManager = LocalClipboardManager.current
    val voteComments = candidate.voteComments.asSequence()
        .mapNotNull { (memberId, comment) ->
            val normalizedComment = comment.trim().takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val displayName = investigation.members
                .firstOrNull { it.id == memberId }
                ?.displayName
                ?: unknownMemberName
            VoteCommentDisplay(memberId, displayName, normalizedComment)
        }
        .sortedBy { it.memberId }
        .toList()

    // tsx styles.container: gap 20 / paddingTop 8
    Column(
        modifier = modifier.padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        // tsx L56-58 header + styles.name: 22sp / bold / colors.text
        Text(
            text = candidate.place.name,
            color = DesignTokens.Colors.text,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
        )

        // tsx L60-91 条件セクション（styles.section: gap 8）
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeading(stringResource(R.string.detail_conditions))
            candidate.evaluations.forEach { evaluation ->
                val requirement =
                    investigation.requirements.firstOrNull { it.id == evaluation.requirementId }
                // tsx L64-66: evidenceIds の順で最初に解決できた Evidence
                val evidence = evaluation.evidenceIds
                    .firstNotNullOfOrNull { id -> candidate.evidence.firstOrNull { it.id == id } }
                // tsx L67: kind = requirement?.kind ?? 'other'
                val kindWire = (requirement?.kind ?: RequirementKind.Other).wire

                val stateLabel = stringResource(Format.matchStateAccessibilityLabel(evaluation.state))
                // tsx styles.evaluationRow: row / center / gap 12 / paddingVertical 8 / 下線 borderSoft
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("inv-claim-$kindWire")
                        .bottomBorder(DesignTokens.Colors.borderSoft, 1.dp)
                        .padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // tsx styles.symbol: 18sp / 800 / 幅 24 / 中央。TalkBack へは記号でなく日本語（tsx L71）
                    Text(
                        text = Format.matchStateSymbol(evaluation.state),
                        modifier = Modifier
                            .width(24.dp)
                            .clearAndSetSemantics {
                                contentDescription = stateLabel
                            },
                        color = Format.matchStateColor(evaluation.state),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.W800,
                        textAlign = TextAlign.Center,
                    )
                    // tsx styles.evaluationInfo: flex 1 / column / gap 2
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        // tsx L80-82 styles.requirementText: 14sp / textSecondary
                        Text(
                            text = requirement?.normalizedText ?: evaluation.requirementId,
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 14.sp,
                        )
                        // tsx styles.explanation: 12sp / lineHeight 18 / textSecondary
                        Text(
                            text = evaluation.explanation,
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                        )
                        // tsx L84-86 styles.sourceLabel: 11sp / lineHeight 16 / colors.info
                        Text(
                            text = sourceLabel(evidence, unknownSource),
                            modifier = Modifier.testTag("inv-claim-source-$kindWire"),
                            color = DesignTokens.Colors.info,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                        )
                    }
                }
            }
        }

        // tsx L93-105 Evidence セクション
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeading("Evidence")
            if (candidate.evidence.isNotEmpty()) {
                candidate.evidence.forEach { evidence ->
                    EvidenceItem(evidence = evidence, onOpenUrl = onOpenUrl)
                }
            } else {
                // tsx styles.empty: 13sp / textTertiary / italic
                Text(
                    text = stringResource(R.string.evidence_empty),
                    color = DesignTokens.Colors.textTertiary,
                    fontSize = 13.sp,
                    fontStyle = FontStyle.Italic,
                )
            }
            // tsx L102-104 styles.evidenceFootnote: 10sp / lineHeight 15 / textTertiary
            Text(
                text = stringResource(R.string.evidence_footnote),
                modifier = Modifier.testTag("inv-evidence-footnote"),
                color = DesignTokens.Colors.textTertiary,
                fontSize = 10.sp,
                lineHeight = 15.sp,
            )
        }

        // tsx L107-123 矛盾セクション（contradictions がある時のみ。testID はセクション View に付く）
        if (candidate.contradictions.isNotEmpty()) {
            Column(
                modifier = Modifier.testTag("inv-contradiction"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SectionHeading(stringResource(R.string.detail_contradictions))
                candidate.contradictions.forEach { contradiction ->
                    // tsx styles.contradiction: bg warningSoft / radius xs / padding 12 / gap 4 / 枠 warning
                    val shape = RoundedCornerShape(DesignTokens.Radius.xs)
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(DesignTokens.Colors.warningSoft)
                            .border(1.dp, DesignTokens.Colors.warning, shape)
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        // tsx styles.contradictionTitle: 14sp / bold / colors.warning
                        Text(
                            text = contradiction.key,
                            color = DesignTokens.Colors.warning,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        contradiction.entries.forEach { entry ->
                            // tsx L117: `{entry.evidenceId}: {String(entry.value)}`（13sp / textSecondary）
                            Text(
                                text = "${entry.evidenceId}: ${contradictionValueText(entry.value)}",
                                color = DesignTokens.Colors.textSecondary,
                                fontSize = 13.sp,
                            )
                        }
                    }
                }
            }
        }

        // tsx L125-128 投票セクション（VoteButtons は同 package の別ファイル）
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeading(stringResource(R.string.detail_vote))
            VoteCommentEditor(
                candidateId = candidate.id,
                currentVote = currentVote,
                initialComment = currentVoteComment,
                onVote = onVote,
                onVoteWithComment = onVoteWithComment,
            )
            if (voteComments.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("vote-comments"),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    voteComments.forEach { entry ->
                        Text(
                            text = "${entry.displayName}: ${entry.comment}",
                            modifier = Modifier.testTag("vote-comment-${entry.memberId}"),
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                        )
                    }
                }
            }
        }

        // tsx L130-195 決定テキスト（styles.decisionSection: gap 8 / paddingTop 4 / 上線 borderSoft）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .topBorder(DesignTokens.Colors.borderSoft, 1.dp)
                .padding(top = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SectionHeading(stringResource(R.string.detail_decided))
            val decisionClickLabel = stringResource(R.string.detail_decision_a11y)
            // tsx styles.decisionButton: minHeight 42 / radius sm / bg orange。文字 13sp / 700 / 白
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("decision-button")
                    .heightIn(min = 42.dp)
                    .clip(RoundedCornerShape(DesignTokens.Radius.sm))
                    .background(DesignTokens.Colors.orange)
                    .clickable(onClickLabel = decisionClickLabel) {
                        // tsx L138-139: 既に形式選択済みなら維持（current ?? 'short'）
                        decisionFormat = decisionFormat ?: DecisionFormat.Short
                        copied = false
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.detail_decision_button),
                    color = DesignTokens.Colors.surface,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.W700,
                )
            }

            val format = decisionFormat
            if (format != null) {
                // tsx styles.decisionBody: gap 8
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // tsx styles.decisionFormatRow: row / gap 8
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FormatButton(
                            label = stringResource(R.string.detail_format_short),
                            tag = "decision-short",
                            accessibilityLabel = stringResource(R.string.detail_format_short_a11y),
                            isSelected = format == DecisionFormat.Short,
                            onClick = {
                                decisionFormat = DecisionFormat.Short
                                copied = false
                            },
                            modifier = Modifier.weight(1f),
                        )
                        FormatButton(
                            label = stringResource(R.string.detail_format_detailed),
                            tag = "decision-detailed",
                            accessibilityLabel = stringResource(R.string.detail_format_detailed_a11y),
                            isSelected = format == DecisionFormat.Detailed,
                            onClick = {
                                decisionFormat = DecisionFormat.Detailed
                                copied = false
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }

                    val previewText = when (format) {
                        DecisionFormat.Short -> decisionText.short
                        DecisionFormat.Detailed -> decisionText.detailed
                    }
                    // tsx L176-178 styles.decisionPreview: selectable / minHeight 100 / padding 10 /
                    // radius xs / bg surfaceSoft / 12sp / lineHeight 19 / textSecondary
                    SelectionContainer {
                        Text(
                            text = previewText,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("decision-text")
                                .heightIn(min = 100.dp)
                                .clip(RoundedCornerShape(DesignTokens.Radius.xs))
                                .background(DesignTokens.Colors.surfaceSoft)
                                .padding(10.dp),
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 12.sp,
                            lineHeight = 19.sp,
                        )
                    }

                    val copyClickLabel = stringResource(
                        if (format == DecisionFormat.Short) R.string.detail_copy_short_a11y else R.string.detail_copy_detailed_a11y,
                    )
                    // tsx styles.copyButton: minHeight 38 / radius xs / 枠 border。文字 12sp / 700
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("decision-copy")
                            .heightIn(min = 38.dp)
                            .clip(RoundedCornerShape(DesignTokens.Radius.xs))
                            .border(
                                1.dp,
                                DesignTokens.Colors.border,
                                RoundedCornerShape(DesignTokens.Radius.xs),
                            )
                            .clickable(
                                onClickLabel = copyClickLabel,
                            ) {
                                // tsx L38-52 handleCopyDecision。Android では常に成功する（成功系のみ）
                                clipboardManager.setText(AnnotatedString(previewText))
                                copied = true
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = stringResource(R.string.detail_copy),
                            color = DesignTokens.Colors.text,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.W700,
                        )
                    }

                    // tsx L188 styles.copyStatus: 11sp / lineHeight 16 / textSecondary
                    if (copied) {
                        Text(
                            text = stringResource(R.string.detail_copied),
                            color = DesignTokens.Colors.textSecondary,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                        )
                    }
                }
            }
        }
    }
}

private data class VoteCommentDisplay(
    val memberId: String,
    val displayName: String,
    val comment: String,
)

/**
 * Web の VoteCommentEditor 相当。票を選ぶ操作では現在のコメントも同時に保存し、
 * 既存票のコメントだけを変更する場合は「コメントを保存」を使う。
 * コメント未入力は null として渡し、既存コメントを削除できるようにする。
 */
@Composable
internal fun VoteCommentEditor(
    candidateId: String,
    currentVote: VoteValue?,
    initialComment: String?,
    onVote: (VoteValue) -> Unit,
    onVoteWithComment: ((VoteValue, String?) -> Unit)?,
) {
    var commentDraft by remember(candidateId, initialComment) {
        mutableStateOf(initialComment.orEmpty())
    }

    fun submitVote(value: VoteValue) {
        val normalizedComment = commentDraft.trim().takeIf { it.isNotEmpty() }
        if (onVoteWithComment != null) {
            onVoteWithComment(value, normalizedComment)
        } else {
            // 旧呼び出し元はコメント保存に対応していないため、票だけ保存する。
            onVote(value)
        }
    }

    VoteButtons(current = currentVote, onVote = ::submitVote)
    OutlinedTextField(
        value = commentDraft,
        onValueChange = { commentDraft = it },
        enabled = onVoteWithComment != null,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("vote-comment-input"),
        label = { Text(stringResource(R.string.vote_comment_label)) },
        placeholder = { Text(stringResource(R.string.vote_comment_placeholder)) },
        minLines = 2,
        maxLines = 4,
    )
    Button(
        onClick = { currentVote?.let(::submitVote) },
        enabled = currentVote != null && onVoteWithComment != null,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("vote-comment-save"),
    ) {
        Text(stringResource(R.string.vote_comment_save))
    }
    if (currentVote == null) {
        Text(
            text = stringResource(R.string.vote_comment_hint),
            modifier = Modifier.testTag("vote-comment-hint"),
            color = DesignTokens.Colors.textSecondary,
            fontSize = 12.sp,
            lineHeight = 18.sp,
        )
    }
}

/** tsx styles.heading: 15sp / bold / colors.text / marginBottom 4（section の gap 8 と併用） */
@Composable
private fun SectionHeading(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(bottom = 4.dp),
        color = DesignTokens.Colors.text,
        fontSize = 15.sp,
        fontWeight = FontWeight.Bold,
    )
}

/**
 * tsx L216-235 EvidenceItem。行タップで出典 URL を開く（tsx は Linking.openURL、ここは onOpenUrl）。
 * styles.evidenceItem: bg surface / radius xs / padding 12 / gap 4 / 枠 borderSoft
 */
@Composable
private fun EvidenceItem(evidence: Evidence, onOpenUrl: (String) -> Unit) {
    val shape = RoundedCornerShape(DesignTokens.Radius.xs)
    val sourceName = evidence.sourceTitle ?: evidence.sourceType
    val openClickLabel = stringResource(R.string.evidence_open_a11y, sourceName)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.borderSoft, shape)
            .clickable(onClickLabel = openClickLabel) {
                onOpenUrl(evidence.sourceUrl)
            }
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // tsx styles.evidenceSource: 14sp / bold / colors.text
        Text(
            text = sourceName,
            color = DesignTokens.Colors.text,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
        )
        // tsx styles.evidenceExcerpt: 13sp / lineHeight 20 / textSecondary
        Text(
            text = evidence.excerpt,
            color = DesignTokens.Colors.textSecondary,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )
        // tsx L230-232: testID は URL の Text に付く。11sp / colors.info / marginTop 2
        Text(
            text = evidence.sourceUrl,
            modifier = Modifier
                .padding(top = 2.dp)
                .testTag("evidence-source-url"),
            color = DesignTokens.Colors.info,
            fontSize = 11.sp,
        )
    }
}

/**
 * tsx L149-175 formatButton / formatButtonActive。
 * 通常: 枠 border / bg surface。選択中: 枠 orange / bg activeBg。minHeight 34 / radius xs。
 */
@Composable
private fun FormatButton(
    label: String,
    tag: String,
    accessibilityLabel: String,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(DesignTokens.Radius.xs)
    Box(
        modifier = modifier
            .testTag(tag)
            .heightIn(min = 34.dp)
            .clip(shape)
            .background(
                if (isSelected) DesignTokens.Colors.activeBg else DesignTokens.Colors.surface,
            )
            .border(
                1.dp,
                if (isSelected) DesignTokens.Colors.orange else DesignTokens.Colors.border,
                shape,
            )
            .clickable(onClickLabel = accessibilityLabel, onClick = onClick)
            // tsx accessibilityState={{ selected }} 相当
            .semantics { selected = isSelected },
        contentAlignment = Alignment.Center,
    ) {
        // tsx styles.formatButtonText: 12sp / 600 / colors.text
        Text(
            text = label,
            color = DesignTokens.Colors.text,
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
        )
    }
}

/**
 * tsx L200-203 mapUrlFor。encodeURIComponent は android.net.Uri.encode と同一の
 * 非エスケープ集合（A-Za-z0-9 と "_-!.~'()*"）を持つため 1:1 に一致する。
 */
private fun mapUrlFor(candidate: Candidate): String {
    val query = candidate.place.address ?: candidate.place.name
    return "https://www.google.com/maps/search/?api=1&query=${Uri.encode(query)}"
}

/**
 * tsx L205-214 sourceLabel。
 * evidence 無し → 「出典不明」。URL 解析成功 → 「{sourceTitle ?? sourceType} · {domain}」
 * （hostname の先頭 www. を除去）。new URL() 失敗相当（host 無し・構文異常）→ title/type のみ。
 */
private fun sourceLabel(evidence: Evidence?, unknownSource: String): String {
    if (evidence == null) return unknownSource
    val name = evidence.sourceTitle ?: evidence.sourceType
    return try {
        val host = URI(evidence.sourceUrl).host ?: return name
        val domain = host.replace(Regex("^www\\.", RegexOption.IGNORE_CASE), "")
        "$name · $domain"
    } catch (_: Exception) {
        name
    }
}

/**
 * tsx L117 `String(entry.value)` 相当。
 * JsonPrimitive は引用符なしの content（"17:00-23:00" / true→"true"）、JsonNull は
 * contentOrNull が null のため toString() = "null"（JS String(null) と同値）。
 * オブジェクト/配列は JSON 文字列にフォールバックする。
 */
private fun contradictionValueText(value: JsonElement): String =
    (value as? JsonPrimitive)?.contentOrNull ?: value.toString()

/** RN の borderBottomWidth 相当（レイアウト空間を消費しない下線） */
private fun Modifier.bottomBorder(color: Color, strokeWidth: Dp): Modifier = drawBehind {
    val y = size.height - strokeWidth.toPx() / 2f
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth.toPx())
}

/** RN の borderTopWidth 相当（レイアウト空間を消費しない上線） */
private fun Modifier.topBorder(color: Color, strokeWidth: Dp): Modifier = drawBehind {
    val y = strokeWidth.toPx() / 2f
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth.toPx())
}
