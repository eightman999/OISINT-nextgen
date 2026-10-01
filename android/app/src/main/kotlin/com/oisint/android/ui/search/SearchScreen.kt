package com.oisint.android.ui.search

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.ui.components.LocationPickerPanel
import com.oisint.android.ui.components.TasteProfilePanel
import com.oisint.android.ui.home.HomeUiState
import com.oisint.android.ui.home.HomeViewModel

/** index.tsx L35 FILTER_CHIPS（逐語） */
private val FILTER_CHIPS = listOf("禁煙", "個室", "カード可", "徒歩5分以内", "Wi-Fi", "静か", "子連れOK")

/**
 * 検索スクリーン。
 *
 * #308: 説明と「調べる」操作を同じ画面に並べない。Home は場面選択までを担い、
 * 条件入力から捜査開始までは検索カード 1 枚だけのこの画面で完結させる。
 * ViewModel は Home と同一インスタンスを共有するので、場面テンプレートで入れた
 * 条件はそのまま引き継がれる。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SearchScreen(
    viewModel: HomeViewModel,
    onBack: () -> Unit,
    onNavigateToInvestigation: (id: String, shareToken: String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(state.navigateTo) {
        state.navigateTo?.let { (id, shareToken) ->
            viewModel.onNavigated()
            onNavigateToInvestigation(id, shareToken)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            // #240: system bar insets はスクロールコンテンツの内側 padding として消費する
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .testTag("search-screen"),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "← 戻る",
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.orange,
                modifier = Modifier
                    .testTag("search-back")
                    .clickable(role = Role.Button, onClick = onBack)
                    .padding(vertical = 6.dp),
            )
        }

        WorkbenchHeader()
        Workbench(viewModel, state)
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * ワークベンチ見出し（index.tsx workbenchHeader）。
 * #308: 説明領域と「調べる」操作領域の境界を明示するため、見出しは操作側にだけ付ける。
 */
@Composable
private fun WorkbenchHeader() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Bottom,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "条件を整える",
                fontSize = 9.sp,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Spacer(Modifier.height(7.dp))
            Text(
                "今夜の条件を、もう少しだけ具体的に。",
                fontSize = 21.sp,
                lineHeight = 31.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
            )
        }
        Spacer(Modifier.width(20.dp))
        Text(
            "新しい店探しをはじめる",
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.textTertiary,
            modifier = Modifier.padding(bottom = 3.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Workbench(viewModel: HomeViewModel, state: HomeUiState) {
    // #308 / PR #364: 説明（選び方の流れ）と「調べる」操作を 1 枚の同質なカードに見せない。
    // 外枠は index.tsx workbench（border / radius 4 / surface）、内側を
    // lp-workbench-main（操作）と lp-workbench-aside（説明）に分け、背景色と境界線で役割を分ける。
    Column(
        Modifier
            .padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(4.dp))
            .testTag("lp-workbench"),
    ) {
        WorkbenchMain(viewModel, state)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkbenchMain(viewModel: HomeViewModel, state: HomeUiState) {
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("lp-workbench-main")
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // ワークベンチイントロ（index.tsx workbenchMarker「店」）
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(24.dp)
                    .background(DesignTokens.Colors.black, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("店", color = DesignTokens.Colors.surface, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                "いまの気分を、そのまま書く",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.text,
            )
        }

        LocationPickerPanel(
            location = state.location,
            onLocationChange = viewModel::onLocationChange,
        )
        TasteProfilePanel(
            profile = state.tasteProfile,
            onProfileChange = viewModel::onTasteProfileChange,
        )

        // 検索ボックス + 捜査開始（index.tsx searchBox / testID home-query, home-start）
        Column(
            Modifier
                .fillMaxWidth()
                .testTag("lp-search-box")
                .background(DesignTokens.Colors.surface, RoundedCornerShape(10.dp))
                .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(10.dp))
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(DesignTokens.Colors.canvas, RoundedCornerShape(DesignTokens.Radius.sm))
                    .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(DesignTokens.Radius.sm))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (state.query.isEmpty()) {
                    Text(
                        "例：池袋で、みんなが話しやすい肉の店を探して",
                        fontSize = 13.sp,
                        color = DesignTokens.Colors.textTertiary,
                    )
                }
                BasicTextField(
                    value = state.query,
                    onValueChange = viewModel::onQueryChange,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 13.sp,
                        color = DesignTokens.Colors.text,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("home-query"),
                )
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .testTag("home-start")
                    .background(
                        if (state.canStart) DesignTokens.Colors.black else DesignTokens.Colors.textTertiary,
                        RoundedCornerShape(7.dp),
                    )
                    .clickable(enabled = state.canStart) { viewModel.handleStart() }
                    .padding(vertical = 12.dp),
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
                        "捜査をはじめる ↗",
                        color = DesignTokens.Colors.surface,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        if (state.errorMessage.isNotEmpty()) {
            Text(
                state.errorMessage,
                fontSize = 12.sp,
                color = DesignTokens.Colors.danger,
            )
        }

        // FILTER_CHIPS（index.tsx L483-500）
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FILTER_CHIPS.forEach { chip ->
                val active = state.selectedChips.contains(chip)
                Box(
                    Modifier
                        .background(
                            if (active) DesignTokens.Colors.activeBg else DesignTokens.Colors.chipBg,
                            RoundedCornerShape(DesignTokens.Radius.pill),
                        )
                        .border(
                            1.dp,
                            if (active) DesignTokens.Colors.orange else DesignTokens.Colors.borderSoft,
                            RoundedCornerShape(DesignTokens.Radius.pill),
                        )
                        .clickable { viewModel.toggleChip(chip) }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    Text(
                        chip,
                        fontSize = 12.sp,
                        color = if (active) DesignTokens.Colors.orange else DesignTokens.Colors.textSecondary,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }

        // 表示名入力（index.tsx identityRow。placeholder「表示名（任意）」）
        Column {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(DesignTokens.Colors.surface, RoundedCornerShape(DesignTokens.Radius.sm))
                    .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.sm))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (state.displayName.isEmpty()) {
                    Text(
                        "表示名（任意）",
                        fontSize = 13.sp,
                        color = DesignTokens.Colors.textTertiary,
                    )
                }
                BasicTextField(
                    value = state.displayName,
                    onValueChange = viewModel::onDisplayNameChange,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 13.sp,
                        color = DesignTokens.Colors.text,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("home-name"),
                )
            }
            Text(
                "任意です。共有したときに表示されます",
                fontSize = 10.sp,
                color = DesignTokens.Colors.textTertiary,
            )
        }

        Text(
            "急ぎなら、場所と条件を一文だけで開始できます。調査の途中でも、みんなで条件を足せます。",
            fontSize = 11.sp,
            color = DesignTokens.Colors.textSecondary,
        )
    }
}
