package com.oisint.android.ui.join

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.ui.components.CandidateCard
import com.oisint.android.ui.components.OisintFooter

/**
 * 共有トークン参加画面。正典は `app/i/[token].tsx`（222 行）。
 * 文言・testID・スタイル値は tsx 逐語（maxWidth 480 / padding 24 / gap 12）。
 */
@Composable
fun JoinScreen(
    viewModel: JoinViewModel,
    onNavigateToInvestigation: (id: String, shareToken: String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val uriHandler = LocalUriHandler.current

    LaunchedEffect(state.navigateTo) {
        state.navigateTo?.let { (id, shareToken) ->
            viewModel.onNavigated()
            onNavigateToInvestigation(id, shareToken)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            // #240: system bar insets はスクロールコンテンツの内側 padding として消費する
            // （verticalScroll より後ろに置く。外側に置くとスクロール領域自体が切り取られる）
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .testTag("join-landing"),
    ) {
        Column(
            Modifier
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .align(Alignment.CenterHorizontally)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // previewSection（tsx L62-82。mock のみ preview が入る）
            val preview = state.preview
            if (preview != null) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .testTag("join-candidates-preview")
                        .padding(bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        preview.title,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = DesignTokens.Colors.text,
                        modifier = Modifier.testTag("join-context-preview"),
                    )
                    Text(
                        "候補を先に確認できます。表示名は投票や条件追加のときに使います。",
                        fontSize = 13.sp,
                        lineHeight = 20.sp,
                        color = DesignTokens.Colors.textSecondary,
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        preview.candidates.forEach { candidate ->
                            CandidateCard(
                                candidate = candidate,
                                requirements = preview.requirements,
                                members = preview.members,
                                selected = false,
                                onClick = {},
                            )
                        }
                    }
                    Text(
                        "今すぐ決めなくても、候補と根拠を見てから参加できます。",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = DesignTokens.Colors.textTertiary,
                        modifier = Modifier.testTag("impulse-exit"),
                    )
                }
            }

            // tsx L84-87
            Text(
                "この調査に参加",
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.5).sp,
                color = DesignTokens.Colors.text,
            )
            Text(
                "まず候補を見てから、必要なら表示名を設定できます。",
                fontSize = 13.sp,
                lineHeight = 20.sp,
                color = DesignTokens.Colors.textSecondary,
            )

            // tsx L89-99 表示名入力
            Text(
                "表示名",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.textSecondary,
            )
            BasicTextField(
                value = state.displayName,
                onValueChange = viewModel::onDisplayNameChange,
                modifier = Modifier
                    .testTag("join-name")
                    .fillMaxWidth()
                    .background(DesignTokens.Colors.surface, RoundedCornerShape(DesignTokens.Radius.md))
                    .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.md))
                    .semantics { contentDescription = "表示名" },
                textStyle = TextStyle(fontSize = 16.sp, color = DesignTokens.Colors.text),
                cursorBrush = SolidColor(DesignTokens.Colors.text),
                singleLine = true,
                decorationBox = { innerTextField ->
                    Box(Modifier.padding(14.dp)) {
                        if (state.displayName.isEmpty()) {
                            // tsx L97-98: placeholder（#9ca3af は tsx 直書き値）
                            Text(
                                "任意（未入力はゲスト）",
                                fontSize = 16.sp,
                                color = androidx.compose.ui.graphics.Color(0xFF9CA3AF),
                            )
                        }
                        innerTextField()
                    }
                },
            )

            // tsx L101-117 参加ボタン
            Box(
                Modifier
                    .testTag("join-button")
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .background(
                        if (state.loading) DesignTokens.Colors.border else DesignTokens.Colors.orange,
                        RoundedCornerShape(DesignTokens.Radius.sm),
                    )
                    .clickable(enabled = !state.loading, role = Role.Button) { viewModel.join() }
                    .semantics {
                        contentDescription = if (state.loading) "調査に参加中" else "調査に参加"
                    }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (state.loading) {
                    CircularProgressIndicator(
                        color = DesignTokens.Colors.surface,
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        "参加",
                        color = DesignTokens.Colors.surface,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            // tsx L118-122 エラー
            if (state.errorMessage.isNotEmpty()) {
                Text(
                    state.errorMessage,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    color = DesignTokens.Colors.danger,
                )
            }
        }

        OisintFooter(onOpenLink = { uriHandler.openUri(it) })
    }
}
