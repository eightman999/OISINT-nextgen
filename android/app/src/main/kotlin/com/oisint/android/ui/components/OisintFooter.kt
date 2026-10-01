package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens

/** Footer.tsx L16-39 の 4 リンク（label / accessibilityLabel 逐語。URL は oisint.com 絶対 URL） */
private data class FooterLinkSpec(
    val testTag: String,
    @StringRes val label: Int,
    @StringRes val accessibilityLabel: Int,
    val url: String,
)

private val FOOTER_LINKS = listOf(
    FooterLinkSpec("footer-help", R.string.footer_help, R.string.footer_help_a11y, "https://oisint.com/help"),
    FooterLinkSpec("footer-support", R.string.footer_support, R.string.footer_support_a11y, "https://oisint.com/support"),
    FooterLinkSpec("footer-contact", R.string.footer_contact, R.string.footer_contact_a11y, "https://oisint.com/contact"),
    FooterLinkSpec("footer-feedback", R.string.footer_feedback, R.string.footer_feedback_a11y, "https://oisint.com/feedback"),
)

/**
 * スマホ幅（2 行フッター）と広い幅（従来 1 行フッター）の分岐閾値（#240 追加要件）。
 * material3 WindowWidthSizeClass の Compact/Medium 境界 600dp と同値にし、
 * InvestigationScreen の 2 ペイン分岐（Phase 8）と「スマホ幅」の定義を揃える。
 */
private val FOOTER_SINGLE_ROW_MIN_WIDTH = 600.dp

/**
 * 共通フッター。正典は src/components/Footer.tsx（spec.md §27: Geoapify/OSM の
 * クレジット表記は全画面必須）。
 *
 * レイアウト移植（Footer.tsx styles）:
 * - container L71-78: paddingVertical 16 / paddingHorizontal 24 / bg surfaceSoft /
 *   中央寄せ / 上 border 1 borderSoft
 * - inner L79-86: maxWidth 1100 の Row・両端揃え（space-between）・gap 12
 * - links L87-90: 横スクロール・gap 2
 *
 * #240 追加要件（2026-08-16 ユーザー指示。Web 側の対応 Issue は #244）:
 * スマホ幅（< 600dp）では Web の横スクロール 1 行を上書きし、
 * 1 行目 = クレジット / 2 行目 = 4 リンク（収まらない場合は FlowRow で折り返し）の
 * 2 行構成にして、横スクロールも見切れも発生させない。
 * 広い幅（>= 600dp）では従来の 1 行レイアウト（両端揃え）を維持する。
 * 配色・フォント・リンク文言・accessibilityLabel・testTag は不変（変えるのは行構成のみ）。
 *
 * testTag "footer-credit" はクレジット文言 Text に付ける（e2e/tests/golden-path.spec.ts L34 が
 * 「Geoapify」含有をこのタグで検証するため。Web は container に付与しているが、
 * Compose のテキスト assert が直接効く位置に置く）。
 */
@Composable
fun OisintFooter(onOpenLink: (String) -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(DesignTokens.Colors.surfaceSoft),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Footer.tsx L76-77: borderTopWidth 1 / borderTopColor borderSoft
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(DesignTokens.Colors.borderSoft),
        )
        BoxWithConstraints(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.TopCenter,
        ) {
            if (maxWidth < FOOTER_SINGLE_ROW_MIN_WIDTH) {
                TwoRowFooter(onOpenLink)
            } else {
                SingleRowFooter(onOpenLink)
            }
        }
    }
}

/**
 * スマホ幅（< 600dp）: 1 行目 = クレジット、2 行目 = 4 リンク。
 * リンク行は FlowRow で、幅に収まらない場合は画面外に出さず折り返す（#240 追加要件）。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TwoRowFooter(onOpenLink: (String) -> Unit) {
    Column(
        modifier = Modifier
            .padding(vertical = 16.dp, horizontal = 24.dp)
            .fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp), // inner gap 12 を行間に転用
    ) {
        FooterCredit()
        FlowRow(
            // links L87-90 の gap 2 を維持。折り返し時も中央揃え（container の中央寄せに準拠）
            horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
        ) {
            FOOTER_LINKS.forEach { link ->
                FooterLink(spec = link, onOpenLink = onOpenLink)
            }
        }
    }
}

/** 広い幅（>= 600dp）: 従来の 1 行レイアウト（Footer.tsx inner L79-86 の両端揃え）を維持 */
@Composable
private fun SingleRowFooter(onOpenLink: (String) -> Unit) {
    Row(
        modifier = Modifier
            .padding(vertical = 16.dp, horizontal = 24.dp)
            .widthIn(max = 1100.dp)
            .fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        FooterCredit()
        Row(
            modifier = Modifier
                .padding(start = 12.dp) // inner gap 12
                .horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            FOOTER_LINKS.forEach { link ->
                FooterLink(spec = link, onOpenLink = onOpenLink)
            }
        }
    }
}

/** Footer.tsx の Geoapify/OSM 帰属表記 */
@Composable
private fun FooterCredit() {
    Text(
        "© OpenStreetMap contributors · Powered by Geoapify",
        modifier = Modifier.testTag("footer-credit"),
        fontSize = 12.sp,
        color = DesignTokens.Colors.textSecondary,
    )
}

/** Footer.tsx L46-68 FooterLink: minHeight 32 / paddingHorizontal 8、orange・12sp・Bold */
@Composable
private fun FooterLink(spec: FooterLinkSpec, onOpenLink: (String) -> Unit) {
    val accessibilityLabel = stringResource(spec.accessibilityLabel)
    Box(
        modifier = Modifier
            .testTag(spec.testTag)
            .semantics { contentDescription = accessibilityLabel }
            .clickable(role = Role.Button) { onOpenLink(spec.url) }
            .defaultMinSize(minHeight = 32.dp)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "${stringResource(spec.label)} ↗",
            color = DesignTokens.Colors.orange,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}
