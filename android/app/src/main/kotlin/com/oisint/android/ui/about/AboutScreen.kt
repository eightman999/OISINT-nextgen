package com.oisint.android.ui.about

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.ui.components.ProcessGuideCard

/**
 * 「選び方の流れ」ページ。
 *
 * #308: Home に説明と検索を同居させないため、説明はこのページに分離する。
 * Home からは導線カード（testTag "home-about-link"）で遷移する。
 */
@Composable
fun AboutScreen(onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            // #240: system bar insets はスクロールコンテンツの内側 padding として消費する
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .testTag("about-screen"),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.common_back),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.orange,
                modifier = Modifier
                    .testTag("about-back")
                    .clickable(role = Role.Button, onClick = onBack)
                    .padding(vertical = 6.dp),
            )
        }

        Column(
            Modifier.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(
                stringResource(R.string.about_eyebrow),
                fontSize = 9.sp,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Text(
                stringResource(R.string.about_title),
                fontSize = 21.sp,
                lineHeight = 31.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
            )
        }

        Spacer(Modifier.height(16.dp))
        ProcessGuideCard(Modifier.padding(horizontal = 16.dp))
        Spacer(Modifier.height(24.dp))
    }
}
