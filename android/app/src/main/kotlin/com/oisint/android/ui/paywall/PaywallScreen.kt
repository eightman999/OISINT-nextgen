package com.oisint.android.ui.paywall

import com.oisint.android.entitlement.RevenueCatEntitlementContract
import com.oisint.android.R
import androidx.annotation.StringRes
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
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

@OptIn(ExperimentalLayoutApi::class)
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
            stringResource(R.string.common_back),
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
                stringResource(R.string.paywall_title),
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
            )
            Text(
                stringResource(R.string.paywall_intro),
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
            Text(stringResource(R.string.paywall_restore), fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (state.restoring) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        }
        if (!state.isAuthenticated) {
            Text(
                stringResource(R.string.paywall_anonymous_notice),
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
                Text(stringResource(R.string.paywall_connect_account))
            }
        }
        state.noticeMessage?.let {
            Text(stringResource(it), color = DesignTokens.Colors.success, fontSize = 12.sp, modifier = Modifier.padding(16.dp).testTag("paywall-notice"))
        }
        state.errorMessage?.let {
            Text(stringResource(it), color = DesignTokens.Colors.danger, fontSize = 12.sp, modifier = Modifier.padding(16.dp).testTag("paywall-error"))
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .testTag("paywall-legal-links"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(stringResource(R.string.paywall_before_purchase_title), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(
                stringResource(R.string.paywall_before_purchase_body),
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                listOf(
                    Triple("terms", R.string.paywall_legal_terms, "https://oisint.com/terms"),
                    Triple("privacy", R.string.paywall_legal_privacy, "https://oisint.com/privacy"),
                    Triple("commercial", R.string.paywall_legal_commercial, "https://oisint.com/commercial-transactions"),
                    Triple("refund", R.string.paywall_legal_refund, "https://oisint.com/support"),
                    Triple("support", R.string.paywall_legal_support, "https://oisint.com/support"),
                ).forEach { (id, label, url) ->
                    Text(
                        stringResource(label),
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
        Text(stringResource(R.string.paywall_current_plan), fontSize = 9.sp, fontWeight = FontWeight.Bold, color = DesignTokens.Colors.textTertiary)
        Spacer(Modifier.height(6.dp))
        Text(
            stringResource(if (state.status.isPlus) R.string.paywall_status_plus else R.string.paywall_status_free),
            fontSize = 17.sp,
            fontWeight = FontWeight.ExtraBold,
            color = if (state.status.isPlus) DesignTokens.Colors.success else DesignTokens.Colors.text,
        )
        if (state.status.isPlus) {
            Text(
                stringResource(
                    if (state.status.willRenew == true) R.string.paywall_auto_renew_on else R.string.paywall_auto_renew_off,
                ),
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
        Text(stringResource(R.string.paywall_choose_plan), fontSize = 9.sp, fontWeight = FontWeight.Bold, color = DesignTokens.Colors.textTertiary)
        if (state.loadingPackages) {
            Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        } else if (state.packages.isEmpty()) {
            Text(stringResource(R.string.paywall_no_plans), fontSize = 12.sp, color = DesignTokens.Colors.textSecondary)
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
            val title = planTitleRes(pkg.id)?.let { stringResource(it) } ?: pkg.title
            Text(
                title,
                fontSize = 14.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
                modifier = Modifier.testTag("paywall-package-title-${pkg.id}"),
            )
            Text(
                stringResource(R.string.paywall_price_per_period, pkg.priceString, billingPeriodLabel(pkg.period)),
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
                modifier = Modifier.testTag("paywall-package-price-${pkg.id}"),
            )
        }
        when {
            isPlus -> Text(stringResource(R.string.paywall_plan_active), fontSize = 11.sp, color = DesignTokens.Colors.success)
            purchasing -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else -> Text(stringResource(R.string.paywall_subscribe), fontSize = 12.sp, color = if (enabled) DesignTokens.Colors.orange else DesignTokens.Colors.placeholder)
        }
    }
}

/** Store商品ID（Googleは productId:basePlanId）からローカライズ済みプラン名を引く。未知はnull。 */
@StringRes
internal fun planTitleRes(packageId: String): Int? = when (packageId.substringBefore(':')) {
    RevenueCatEntitlementContract.MONTHLY_PRODUCT -> R.string.paywall_plan_monthly
    RevenueCatEntitlementContract.ANNUAL_PRODUCT -> R.string.paywall_plan_annual
    else -> null
}

/** ISO 8601 の課金期間（P1M / P1Y / P2W / P7D）。単純な単一単位だけを解釈する。 */
internal data class BillingPeriod(val unit: Char, val count: Int)

internal fun parseBillingPeriod(iso: String): BillingPeriod? {
    val match = Regex("^P(\\d+)([DWMY])$").matchEntire(iso.trim()) ?: return null
    val count = match.groupValues[1].toIntOrNull() ?: return null
    if (count <= 0) return null
    return BillingPeriod(match.groupValues[2][0], count)
}

/** 課金期間を端末/アプリのロケールで表示する。解釈できない値は原文のまま出す。 */
@Composable
private fun billingPeriodLabel(iso: String): String {
    val period = parseBillingPeriod(iso) ?: return iso
    val res = when (period.unit) {
        'D' -> R.plurals.paywall_period_days
        'W' -> R.plurals.paywall_period_weeks
        'M' -> R.plurals.paywall_period_months
        else -> R.plurals.paywall_period_years
    }
    return pluralStringResource(res, period.count, period.count)
}
