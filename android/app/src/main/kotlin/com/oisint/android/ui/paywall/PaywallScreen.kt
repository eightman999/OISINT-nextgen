package com.oisint.android.ui.paywall

import androidx.activity.compose.LocalActivity
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.entitlement.PlusPackage

@Composable
fun PaywallScreen(
    viewModel: PaywallViewModel,
    onBack: () -> Unit,
    onNavigateToAccount: () -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    val activity = LocalActivity.current
    val uriHandler = LocalUriHandler.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .testTag("paywall-screen"),
    ) {
        Text(
            "← 戻る",
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.orange,
            modifier = Modifier
                .testTag("paywall-back")
                .clickable(role = Role.Button, onClick = onBack)
                .padding(horizontal = 16.dp, vertical = 18.dp),
        )
        Column(
            Modifier.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "OISINT PLUS",
                fontSize = 9.sp,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Text(
                "無料とPlusのプラン",
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
            )
            Text(
                "調査・投票・Evidenceの確認は無料のまま。Plusの適用範囲と利用枠は、購入前の表示内容とアカウント状態で確認できます。",
                fontSize = 12.sp,
                lineHeight = 19.sp,
                color = DesignTokens.Colors.textSecondary,
            )
        }
        Spacer(Modifier.height(16.dp))
        CurrentPlan(state)
        Spacer(Modifier.height(16.dp))
        Plans(
            state = state,
            onPurchase = { id -> activity?.let { viewModel.purchase(it, id) } },
        )
        Spacer(Modifier.height(12.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .testTag("paywall-restore")
                .border(1.dp, DesignTokens.Colors.orangeSoft, RoundedCornerShape(4.dp))
                .clickable(
                    enabled = !state.busy,
                    role = Role.Button,
                    onClick = viewModel::restore,
                )
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("購入を復元", fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (state.restoring) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        }
        if (!state.isAuthenticated) {
            Text(
                "匿名または未接続の状態では購入・復元できません。アカウント登録後にお試しください。",
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            )
            Button(
                onClick = onNavigateToAccount,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .testTag("paywall-account"),
            ) {
                Text("アカウントを接続")
            }
        }
        state.noticeMessage.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = DesignTokens.Colors.success, fontSize = 12.sp, modifier = Modifier.padding(16.dp).testTag("paywall-notice"))
        }
        state.errorMessage.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = DesignTokens.Colors.danger, fontSize = 12.sp, modifier = Modifier.padding(16.dp).testTag("paywall-error"))
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .testTag("paywall-legal-links"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("購入前に確認すること", fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(
                "価格・契約期間・更新・解約・返金条件は、購入元と下記の案内を確認してください。アカウント削除はストア定期購入の解約ではありません。",
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(
                    Triple("terms", "利用規約", "https://oisint.com/terms"),
                    Triple("privacy", "プライバシー", "https://oisint.com/privacy"),
                    Triple("commercial", "特商法表記", "https://oisint.com/commercial-transactions"),
                    Triple("refund", "解約・返金案内", "https://oisint.com/support"),
                    Triple("support", "サポート", "https://oisint.com/support"),
                ).forEach { (id, label, url) ->
                    Text(
                        label,
                        color = DesignTokens.Colors.orange,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .testTag("paywall-legal-$id")
                            .clickable(role = Role.Button) { uriHandler.openUri(url) },
                    )
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun CurrentPlan(state: PaywallUiState) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("paywall-status")
            .background(DesignTokens.Colors.surface, RoundedCornerShape(8.dp))
            .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(8.dp))
            .padding(16.dp),
    ) {
        Text("現在のプラン", fontSize = 9.sp, fontWeight = FontWeight.Bold, color = DesignTokens.Colors.textTertiary)
        Spacer(Modifier.height(6.dp))
        Text(
            if (state.status.isPlus) "OISINT Plus ご利用中" else "無料プラン",
            fontSize = 17.sp,
            fontWeight = FontWeight.ExtraBold,
            color = if (state.status.isPlus) DesignTokens.Colors.success else DesignTokens.Colors.text,
        )
        if (state.status.isPlus) {
            Text(
                if (state.status.willRenew == true) "自動更新あり" else "自動更新なし",
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
            )
        }
    }
}

@Composable
private fun Plans(
    state: PaywallUiState,
    onPurchase: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("paywall-plans"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("プランを選ぶ", fontSize = 9.sp, fontWeight = FontWeight.Bold, color = DesignTokens.Colors.textTertiary)
        if (state.loadingPackages) {
            Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        } else if (state.packages.isEmpty()) {
            Text("現在表示できるプランはありません。", fontSize = 12.sp, color = DesignTokens.Colors.textSecondary)
        } else {
            state.packages.forEach { pkg ->
                PlanCard(
                    pkg = pkg,
                    enabled = state.isAuthenticated && !state.busy && !state.status.isPlus,
                    purchasing = state.purchasingId == pkg.id,
                    isPlus = state.status.isPlus,
                    onClick = { onPurchase(pkg.id) },
                )
            }
        }
    }
}

@Composable
private fun PlanCard(
    pkg: PlusPackage,
    enabled: Boolean,
    purchasing: Boolean,
    isPlus: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("paywall-package-${pkg.id}")
            .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(4.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(pkg.title, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.text)
            Text("${pkg.priceString} / ${pkg.period}", fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        }
        when {
            isPlus -> Text("ご利用中", fontSize = 11.sp, color = DesignTokens.Colors.success)
            purchasing -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else -> Text("加入する →", fontSize = 12.sp, color = if (enabled) DesignTokens.Colors.orange else DesignTokens.Colors.placeholder)
        }
    }
}
