package com.oisint.android.ui.investigation

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.model.Candidate
import com.oisint.android.model.Investigation
import com.oisint.android.model.MatchState
import com.oisint.android.model.RequirementPriority
import com.oisint.android.design.DesignTokens
import com.oisint.android.ui.components.CandidateCard
import com.oisint.android.ui.components.CandidateDetailSection
import com.oisint.android.ui.components.ComparisonPanel
import com.oisint.android.ui.components.EvidencePanel
import com.oisint.android.ui.components.MemberRow
import com.oisint.android.ui.components.OisintFooter
import com.oisint.android.ui.components.ProgressIndicator
import com.oisint.android.ui.components.RequirementChips
import com.oisint.android.ui.components.VotePanel

/**
 * Investigation 詳細画面。正典は `app/investigations/[id].tsx`（588 行）。
 * セクション順: actionError → failed → header → progress → requirements → candidates →
 * bottomGrid → candidateDetail → footer。
 *
 * レイアウト適応（計画書 §3.5 / Issue「タブレットは WindowSizeClass に応じた 2 ペイン」）:
 * - Compact: 単一カラム（Web の width<760 と同型）
 * - Medium/Expanded (isWide): 2 ペイン（左=Progress+Requirements+Candidates、右=CandidateDetail）
 *   + BottomPanels 横並び（Web の width>=760 横並び分岐に対応）
 */
@Composable
fun InvestigationScreen(
    viewModel: InvestigationViewModel,
    shareToken: String?,
    isWide: Boolean = false,
) {
    val state by viewModel.uiState.collectAsState()
    val uriHandler = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current

    if (state.loading) {
        Box(
            Modifier
                .fillMaxSize()
                .background(DesignTokens.Colors.bg),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(color = DesignTokens.Colors.orange)
        }
        return
    }

    val investigation = state.investigation
    if (investigation == null) {
        NotFoundState(error = state.error, onRetry = { viewModel.retry() })
        return
    }

    // [id].tsx L45-47
    val shareUrl = if (!shareToken.isNullOrEmpty()) {
        "https://oisint.com/i/$shareToken"
    } else {
        "https://oisint.com/investigations/${investigation.id}"
    }
    val selectedCandidate = investigation.candidates.firstOrNull { it.id == state.selectedCandidateId }
        ?: investigation.candidates.firstOrNull()

    Column(
        Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            // #240: system bar insets はスクロールコンテンツの内側 padding として消費する
            // （verticalScroll より後ろに置く。外側に置くとスクロール領域自体が切り取られる）
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(bottom = 16.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            // actionError（[id].tsx L163-167）
            state.actionError?.let { actionErrorRes ->
                Text(stringResource(actionErrorRes), color = DesignTokens.Colors.danger, fontSize = 12.sp)
            }

            // failedState（[id].tsx L169-184）
            if (investigation.status.wire == "failed") {
                FailedBanner(retrying = state.retrying, onRetry = { viewModel.retryRun() })
            }

            HeaderSection(
                investigation = investigation,
                shareUrl = shareUrl,
                shareCopied = state.shareCopied,
                onShare = {
                    clipboard.setText(AnnotatedString(shareUrl))
                    viewModel.onShareCopied()
                },
            )

            if (isWide) {
                // 2 ペイン: 左=Progress+Requirements+Candidates（縦積み）、右=CandidateDetail
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        ProgressSection(investigation)
                        RequirementsSection(viewModel, state)
                        CandidatesSection(viewModel, investigation, selectedCandidate)
                    }
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        DetailSection(viewModel, investigation, selectedCandidate, state, uriHandler::openUri)
                    }
                }
                if (investigation.candidates.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ComparisonPanel(investigation = investigation, modifier = Modifier.weight(1f))
                        VotePanel(
                            investigation = investigation,
                            onVotePress = { selectTopRanked(viewModel, investigation) },
                            modifier = Modifier.weight(1f),
                        )
                        EvidencePanel(investigation = investigation, modifier = Modifier.weight(1f))
                    }
                }
            } else {
                ProgressSection(investigation)
                RequirementsSection(viewModel, state)
                CandidatesSection(viewModel, investigation, selectedCandidate)
                if (investigation.candidates.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        ComparisonPanel(investigation = investigation)
                        VotePanel(
                            investigation = investigation,
                            onVotePress = { selectTopRanked(viewModel, investigation) },
                        )
                        EvidencePanel(investigation = investigation)
                    }
                }
                DetailSection(viewModel, investigation, selectedCandidate, state, uriHandler::openUri)
            }
        }

        OisintFooter(onOpenLink = { uriHandler.openUri(it) })
    }
}

/** [id].tsx L298-302: rank 1 位の候補を選択状態にする */
private fun selectTopRanked(viewModel: InvestigationViewModel, investigation: Investigation) {
    investigation.candidates.minByOrNull { it.rank }?.let { viewModel.selectCandidate(it.id) }
}

/** [id].tsx L136-152 */
@Composable
private fun NotFoundState(@StringRes error: Int?, onRetry: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            stringResource(error ?: R.string.investigation_error_load_default),
            color = DesignTokens.Colors.danger,
            fontSize = 13.sp,
        )
        Spacer(Modifier.height(12.dp))
        val reloadDescription = stringResource(R.string.investigation_reload_a11y)
        Box(
            Modifier
                .background(DesignTokens.Colors.black, RoundedCornerShape(DesignTokens.Radius.sm))
                .clickable(onClick = onRetry)
                .semantics { contentDescription = reloadDescription }
                .padding(horizontal = 20.dp, vertical = 10.dp),
        ) {
            Text(stringResource(R.string.investigation_reload), color = DesignTokens.Colors.surface, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** [id].tsx L169-184 */
@Composable
private fun FailedBanner(retrying: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(DesignTokens.Colors.dangerSoft, RoundedCornerShape(DesignTokens.Radius.sm))
            .border(1.dp, DesignTokens.Colors.danger, RoundedCornerShape(DesignTokens.Radius.sm))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.investigation_failed), color = DesignTokens.Colors.danger, fontSize = 13.sp)
        val retryDescription = stringResource(R.string.investigation_retry_a11y)
        Box(
            Modifier
                .background(DesignTokens.Colors.black, RoundedCornerShape(DesignTokens.Radius.sm))
                .clickable(enabled = !retrying, onClick = onRetry)
                .semantics { contentDescription = retryDescription }
                .padding(horizontal = 20.dp, vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (retrying) {
                CircularProgressIndicator(
                    color = DesignTokens.Colors.surface,
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                Text(stringResource(R.string.investigation_retry), color = DesignTokens.Colors.surface, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** [id].tsx L186-205 inv-context */
@Composable
private fun HeaderSection(
    investigation: Investigation,
    shareUrl: String,
    shareCopied: Boolean,
    onShare: () -> Unit,
) {
    Column(Modifier.testTag("inv-context"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                investigation.title,
                fontSize = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
                modifier = Modifier.weight(1f),
            )
            val shareEnabled = investigation.candidates.isNotEmpty()
            val shareDescription = stringResource(
                if (shareCopied) R.string.investigation_share_copied_a11y else R.string.investigation_share_copy_a11y,
            )
            Box(
                Modifier
                    .testTag("inv-share")
                    .background(
                        if (shareEnabled) DesignTokens.Colors.black else DesignTokens.Colors.textTertiary,
                        RoundedCornerShape(8.dp),
                    )
                    .clickable(enabled = shareEnabled, onClick = onShare)
                    .semantics {
                        contentDescription = shareDescription
                    }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text(
                    stringResource(if (shareCopied) R.string.investigation_share_copied else R.string.investigation_share),
                    color = DesignTokens.Colors.surface,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        Text(
            shareUrl,
            fontSize = 11.sp,
            color = DesignTokens.Colors.textTertiary,
            modifier = Modifier.testTag("inv-share-url"),
        )
        MemberRow(members = investigation.members)
    }
}

@Composable
private fun ProgressSection(investigation: Investigation) {
    Box(Modifier.testTag("inv-progress")) {
        ProgressIndicator(status = investigation.status)
    }
}

/** [id].tsx L211-250 */
@Composable
private fun RequirementsSection(viewModel: InvestigationViewModel, state: InvestigationUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RequirementChips(
            requirements = state.investigation?.requirements ?: emptyList(),
            onAddClick = { viewModel.setAddingRequirement(true) },
        )
        if (state.addingRequirement) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(DesignTokens.Colors.surface, RoundedCornerShape(DesignTokens.Radius.sm))
                    .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.sm))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (state.newRequirementText.isEmpty()) {
                    Text(stringResource(R.string.investigation_requirement_placeholder), fontSize = 13.sp, color = DesignTokens.Colors.textTertiary)
                }
                BasicTextField(
                    value = state.newRequirementText,
                    onValueChange = viewModel::onNewRequirementTextChange,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 13.sp,
                        color = DesignTokens.Colors.text,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("inv-add-requirement-input"),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .background(DesignTokens.Colors.surface, RoundedCornerShape(DesignTokens.Radius.sm))
                        .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.sm))
                        .clickable { viewModel.setAddingRequirement(false) }
                        .padding(horizontal = 16.dp, vertical = 9.dp),
                ) {
                    Text(stringResource(R.string.common_cancel), fontSize = 12.sp, color = DesignTokens.Colors.textSecondary)
                }
                Box(
                    Modifier
                        .background(DesignTokens.Colors.orange, RoundedCornerShape(DesignTokens.Radius.sm))
                        .clickable { viewModel.addRequirement() }
                        .padding(horizontal = 16.dp, vertical = 9.dp),
                ) {
                    Text(
                        stringResource(R.string.investigation_requirement_add),
                        fontSize = 12.sp,
                        color = DesignTokens.Colors.surface,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

/** [id].tsx L252-288 inv-candidates */
@Composable
private fun CandidatesSection(
    viewModel: InvestigationViewModel,
    investigation: Investigation,
    selectedCandidate: Candidate?,
) {
    val topCandidate = investigation.candidates.minByOrNull { it.rank }
    val topCandidateHasUnresolvedMust = topCandidate != null && investigation.requirements
        .filter { it.priority == RequirementPriority.Must }
        .any { requirement ->
            val evaluation = topCandidate.evaluations.firstOrNull { it.requirementId == requirement.id }
            evaluation == null || evaluation.state == MatchState.Unknown
        }

    Column(Modifier.testTag("inv-candidates"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            stringResource(
                if (topCandidateHasUnresolvedMust) {
                    R.string.investigation_candidates_comparison
                } else {
                    R.string.investigation_candidates_recommended
                },
            ),
            fontSize = 16.sp,
            fontWeight = FontWeight.ExtraBold,
            color = DesignTokens.Colors.text,
            modifier = Modifier.testTag("inv-candidates-heading"),
        )
        Text(
            pluralStringResource(
                R.plurals.investigation_candidates_found,
                investigation.candidates.size,
                investigation.candidates.size,
            ),
            fontSize = 12.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        when {
            investigation.candidates.isNotEmpty() -> {
                investigation.candidates.forEach { candidate ->
                    CandidateCard(
                        candidate = candidate,
                        requirements = investigation.requirements,
                        members = investigation.members,
                        selected = candidate.id == selectedCandidate?.id,
                        onClick = { viewModel.selectCandidate(candidate.id) },
                    )
                }
            }
            investigation.status.wire == "complete" -> {
                Text(
                    stringResource(R.string.investigation_no_candidates),
                    fontSize = 12.sp,
                    color = DesignTokens.Colors.textSecondary,
                )
            }
            investigation.status.wire != "failed" -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(
                        color = DesignTokens.Colors.orange,
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        stringResource(R.string.investigation_searching),
                        fontSize = 12.sp,
                        color = DesignTokens.Colors.textSecondary,
                    )
                }
            }
        }
    }
}

/** [id].tsx L310-320 */
@Composable
private fun DetailSection(
    viewModel: InvestigationViewModel,
    investigation: Investigation,
    selectedCandidate: Candidate?,
    state: InvestigationUiState,
    onOpenUrl: (String) -> Unit,
) {
    if (selectedCandidate != null) {
        CandidateDetailSection(
            investigation = investigation,
            candidate = selectedCandidate,
            currentVote = state.currentUserId?.let { selectedCandidate.votes[it] },
            currentVoteComment = state.currentUserId?.let { selectedCandidate.voteComments[it] },
            onVote = { value -> viewModel.vote(selectedCandidate.id, value) },
            onVoteWithComment = { value, comment ->
                viewModel.vote(selectedCandidate.id, value, comment)
            },
            onOpenUrl = onOpenUrl,
        )
    }
}
