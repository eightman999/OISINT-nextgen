package com.oisint.android

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.material3.Surface
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.oisint.android.design.DesignTokens
import com.oisint.android.design.OisintTheme
import com.oisint.android.ui.navigation.OisintNavHost

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        // #240: API 35+ は edge-to-edge 強制でテーマの android:statusBarColor が無視される
        // （themes.xml の「ステータスバー = oisint_bg 色」の意図が失われるのが root cause）。
        // enableEdgeToEdge を明示して全 API レベルで挙動を統一する。ライトパレット固定（§3.7）
        // のため SystemBarStyle.auto ではなく light を明示（OS ダーク設定でもアイコンを暗色に保つ。
        // windowLightStatusBar=true と同じ意図）。nav bar の darkScrim は light nav アイコン
        // 非対応の API 26 でのみ使われる保険（enableEdgeToEdge 既定値と同値）
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(
                Color.TRANSPARENT,
                Color.argb(0x80, 0x1B, 0x1B, 0x1B),
            ),
        )
        super.onCreate(savedInstanceState)
        val container = (application as OisintApplication).container
        if (intent.data != null) container.handleAuthDeepLink(intent)
        setContent {
            // WindowSizeClass の標準境界（Compact <600dp / Medium 600-840 / Expanded ≥840）に従う。
            // Web の useWindowDimensions 分岐（760/920 CSS px）とは単位が異なるため混同しない（§3.5）
            val windowSizeClass = calculateWindowSizeClass(this)
            val isWide = windowSizeClass.widthSizeClass != WindowWidthSizeClass.Compact
            OisintTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize()) {
                        OisintNavHost(
                            navController = rememberNavController(),
                            container = container,
                            isWide = isWide,
                        )
                        // #240: ステータスバー保護層。スクロール途中のコンテンツが時計・電波
                        // アイコンと重ならないよう、ステータスバー領域を bg 色で覆う
                        // （themes.xml が API 34 以前で実現していた見え方を Compose で復元。
                        // Web でもブラウザ UI とページは分離されており、この方が Web の見え方に近い）
                        Box(
                            Modifier
                                .align(Alignment.TopCenter)
                                .fillMaxWidth()
                                .windowInsetsTopHeight(WindowInsets.statusBars)
                                .background(DesignTokens.Colors.bg),
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.data != null) {
            (application as OisintApplication).container.handleAuthDeepLink(intent)
        }
    }
}
