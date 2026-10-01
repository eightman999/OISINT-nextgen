package com.oisint.android.ui.home

import androidx.compose.foundation.Image
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.R
import com.oisint.android.design.DesignTokens
import com.oisint.android.ui.components.LocationPickerPanel
import com.oisint.android.ui.components.OisintFooter
import com.oisint.android.ui.components.TasteProfilePanel

/** index.tsx L35 FILTER_CHIPS（逐語） */
private val FILTER_CHIPS = listOf("禁煙", "個室", "カード可", "徒歩5分以内", "Wi-Fi", "静か", "子連れOK")

/** index.tsx L37-77 SCENES（逐語） */
data class Scene(
    val id: String,
    val index: String,
    val label: String,
    val title: String,
    val query: String,
    val location: String,
    val people: String,
    val budget: String,
    val note: String,
    val accent: Color,
    val soft: Color,
)

private val SCENES = listOf(
    Scene(
        id = "home-template-company",
        index = "01",
        label = "会社の飲み会",
        title = "ちゃんと話せる、肉の夜",
        query = "池袋で3人。3000円くらい。肉。カード可。静かめ。",
        location = "池袋",
        people = "3人",
        budget = "3,000円前後",
        note = "仕事の話も、近況も。声が届く店。",
        accent = Color(0xFFF4511E),
        soft = Color(0xFFFFF0E8),
    ),
    Scene(
        id = "home-template-omotenashi",
        index = "02",
        label = "接待・会食",
        title = "落ち着いて選ぶ、和食の席",
        query = "新宿で4人。ひとり6000円前後。個室。落ち着いた和食。",
        location = "新宿",
        people = "4人",
        budget = "6,000円前後",
        note = "店選びの理由まで、きちんと持っていく。",
        accent = Color(0xFF49655D),
        soft = Color(0xFFEDF3EF),
    ),
    Scene(
        id = "home-template-travel",
        index = "03",
        label = "旅行先",
        title = "知らない街で、外さない一軒",
        query = "渋谷で2人。ランチ。写真映えするカフェ。駅から徒歩5分以内。",
        location = "渋谷",
        people = "2人",
        budget = "ランチ",
        note = "せっかくの一日を、店探しで終わらせない。",
        accent = Color(0xFFD99A00),
        soft = Color(0xFFFFF6DD),
    ),
)

// PROCESS_STEPS は #308 で説明ページ側へ移動（ui/components/ProcessGuideCard.kt）。

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HomeScreen(
    viewModel: HomeViewModel,
    onNavigateToInvestigation: (id: String, shareToken: String) -> Unit,
    onNavigateToAbout: () -> Unit = {},
    onNavigateToSearch: () -> Unit = {},
    onNavigateToPaywall: () -> Unit = {},
    onNavigateToAccount: () -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    val uriHandler = LocalUriHandler.current

    LaunchedEffect(state.navigateTo) {
        state.navigateTo?.let { (id, shareToken) ->
            viewModel.onNavigated()
            onNavigateToInvestigation(id, shareToken)
        }
    }

    val selectedScene = SCENES.firstOrNull { it.id == state.selectedSceneId } ?: SCENES[0]

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            // #240: system bar insets はスクロールコンテンツの内側 padding として消費する
            // （verticalScroll より後ろに置く。外側に置くとスクロール領域自体が切り取られる）
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        Topbar(onOpenHelp = { uriHandler.openUri("https://oisint.com/help") })
        Hero(selectedScene, state)
        SectionIntro()
        SceneGrid(
            selectedSceneId = selectedScene.id,
            onSelect = { viewModel.selectScene(it.id, it.query) },
        )
        Spacer(Modifier.height(16.dp))
        SearchLinkCard(onClick = onNavigateToSearch)
        Spacer(Modifier.height(14.dp))
        AboutLinkCard(onClick = onNavigateToAbout)
        Spacer(Modifier.height(14.dp))
        PlusLinkCard(onClick = onNavigateToPaywall)
        Spacer(Modifier.height(14.dp))
        AccountLinkCard(onClick = onNavigateToAccount)
        Spacer(Modifier.height(14.dp))
        OisintFooter(onOpenLink = { uriHandler.openUri(it) })
    }
}

/**
 * 検索スクリーンへの導線カード（本命の操作）。
 * #308: 条件入力から捜査開始までは検索カードだけの別スクリーンで完結させる。
 */
@Composable
private fun SearchLinkCard(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("home-search-link")
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.black)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "条件を整える",
                fontSize = 10.sp,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Spacer(Modifier.height(5.dp))
            Text(
                "今夜の条件を、もう少しだけ具体的に。",
                fontSize = 16.sp,
                lineHeight = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.surface,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "場所・好み・条件を入れて捜査をはじめる",
                fontSize = 11.sp,
                color = DesignTokens.Colors.borderSoft,
            )
        }
        Spacer(Modifier.width(12.dp))
        Text("→", fontSize = 20.sp, color = DesignTokens.Colors.orange)
    }
}

/**
 * 説明ページへの導線カード。
 * #308: Home には導線だけを置き、説明は about ページへ分離する。
 */
@Composable
private fun AboutLinkCard(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("home-about-link")
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.surfaceSoft)
            .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "選び方の流れ",
                fontSize = 10.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "話しながら、候補が見えてくる。",
                fontSize = 14.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.text,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                "OISINT がどう候補を絞るのかを見る",
                fontSize = 11.sp,
                color = DesignTokens.Colors.textSecondary,
            )
        }
        Spacer(Modifier.width(12.dp))
        Text("→", fontSize = 18.sp, color = DesignTokens.Colors.orange)
    }
}

@Composable
private fun PlusLinkCard(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("home-plus-link")
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.orangeSoft, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("OISINT PLUS", fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.orange)
            Spacer(Modifier.height(4.dp))
            Text("無料とPlusのプランを見る", fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.text)
            Spacer(Modifier.height(3.dp))
            Text("匿名利用中は購入できません。アカウント登録後に利用できます。", fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        }
        Spacer(Modifier.width(12.dp))
        Text("→", fontSize = 18.sp, color = DesignTokens.Colors.orange)
    }
}

@Composable
private fun AccountLinkCard(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("home-account-link")
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.surface)
            .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("アカウント", fontSize = 10.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.orange)
            Spacer(Modifier.height(4.dp))
            Text("匿名の調査を引き継ぐ", fontSize = 14.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.text)
            Spacer(Modifier.height(3.dp))
            Text("Google接続またはメールでアカウントを管理します。", fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        }
        Spacer(Modifier.width(12.dp))
        Text("→", fontSize = 18.sp, color = DesignTokens.Colors.orange)
    }
}

@Composable
private fun Topbar(onOpenHelp: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // index.tsx L280: ロゴ画像（assets/branding/oisint-logo-horizontal.png のコピー）
        Image(
            painter = painterResource(R.drawable.oisint_logo_horizontal),
            contentDescription = "OISINT ロゴ",
            modifier = Modifier.size(width = 119.dp, height = 36.dp),
        )
        Spacer(Modifier.weight(1f))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                "SHARED FOOD RESEARCH",
                fontSize = 9.sp,
                color = DesignTokens.Colors.textTertiary,
                letterSpacing = 1.2.sp,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(8.dp)
                        .background(DesignTokens.Colors.orange, CircleShape),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "今夜の作戦会議",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = DesignTokens.Colors.text,
                )
            }
            Text(
                "使い方",
                fontSize = 11.sp,
                color = DesignTokens.Colors.orange,
                textDecoration = TextDecoration.Underline,
                modifier = Modifier.clickable(onClick = onOpenHelp),
            )
        }
    }
}

@Composable
private fun Hero(scene: Scene, state: HomeUiState) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(
            "OISINT / DINNER DECISION DESK",
            fontSize = 10.sp,
            letterSpacing = 1.5.sp,
            color = DesignTokens.Colors.textTertiary,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "「どこ行く？」を、\n「ここがいい」に変える。",
            fontSize = 30.sp,
            lineHeight = 38.sp,
            fontWeight = FontWeight.ExtraBold,
            color = DesignTokens.Colors.text,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            "店を当てるためじゃない。\n人数も、予算も、その日の空気も持ち寄って、\nみんなが納得できる一軒を見つけるための入口です。",
            fontSize = 13.sp,
            lineHeight = 20.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HeroSignal("3人の条件をひとつに")
            HeroSignal("?わからないことも残す")
        }
        Spacer(Modifier.height(14.dp))
        BriefCard(scene, state)
    }
}

@Composable
private fun HeroSignal(text: String) {
    Box(
        Modifier
            .background(DesignTokens.Colors.chipBg, RoundedCornerShape(DesignTokens.Radius.pill))
            .border(
                1.dp,
                DesignTokens.Colors.borderSoft,
                RoundedCornerShape(DesignTokens.Radius.pill),
            )
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(text, fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
    }
}

/** index.tsx のヒーロー右側 Brief Card（LIVE BRIEF / NO / SCENE / MOOD / タグ / FEELING FIRST） */
@Composable
private fun BriefCard(scene: Scene, state: HomeUiState) {
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("lp-brief-card")
            .background(DesignTokens.Colors.surface, RoundedCornerShape(DesignTokens.Radius.md))
            .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(DesignTokens.Radius.md))
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "LIVE BRIEF",
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                color = DesignTokens.Colors.orange,
            )
            Spacer(Modifier.weight(1f))
            Text(
                "NO. ${scene.index}",
                fontSize = 9.sp,
                color = DesignTokens.Colors.textTertiary,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "今夜の候補を、\n一緒につくる",
            fontSize = 18.sp,
            lineHeight = 24.sp,
            fontWeight = FontWeight.ExtraBold,
            color = DesignTokens.Colors.text,
        )
        Spacer(Modifier.height(8.dp))
        Text("SCENE / ${scene.label}", fontSize = 10.sp, color = DesignTokens.Colors.textSecondary)
        Text("MOOD / ${scene.note}", fontSize = 10.sp, color = DesignTokens.Colors.textSecondary)
        Spacer(Modifier.height(8.dp))
        FlowRowTags(scene, state)
        Spacer(Modifier.height(8.dp))
        Row {
            Text(
                "FEELING FIRST",
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.text,
            )
            Spacer(Modifier.width(10.dp))
            Text(
                "LOGIC BEHIND",
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                color = DesignTokens.Colors.textTertiary,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowTags(scene: Scene, state: HomeUiState) {
    // index.tsx previewTags: location, people, budget, likes[0], selectedChips[0]
    val tags = listOfNotNull(
        scene.location,
        scene.people,
        scene.budget,
        state.tasteProfile.likes.firstOrNull(),
        state.selectedChips.firstOrNull(),
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        tags.forEach { tag ->
            Box(
                Modifier
                    .background(scene.soft, RoundedCornerShape(DesignTokens.Radius.pill))
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            ) {
                Text(tag, fontSize = 10.sp, fontWeight = FontWeight.Bold, color = scene.accent)
            }
        }
    }
}

@Composable
private fun SectionIntro() {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
        Text(
            "START WITH A SCENE",
            fontSize = 10.sp,
            letterSpacing = 1.5.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.textTertiary,
        )
        Text(
            "まずは、今夜の状況を選ぶ。",
            fontSize = 20.sp,
            fontWeight = FontWeight.ExtraBold,
            color = DesignTokens.Colors.text,
        )
        Text(
            "選んだあとに、場所や条件を自由に書き足せます。",
            fontSize = 12.sp,
            color = DesignTokens.Colors.textSecondary,
        )
    }
}

@Composable
private fun SceneGrid(selectedSceneId: String, onSelect: (Scene) -> Unit) {
    Column(
        Modifier
            .padding(horizontal = 16.dp)
            .testTag("lp-scene-grid"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SCENES.forEach { scene ->
            val selected = scene.id == selectedSceneId
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(
                        DesignTokens.Colors.surface,
                        RoundedCornerShape(DesignTokens.Radius.md),
                    )
                    .border(
                        if (selected) 2.dp else 1.dp,
                        if (selected) scene.accent else DesignTokens.Colors.border,
                        RoundedCornerShape(DesignTokens.Radius.md),
                    )
                    .clickable { onSelect(scene) }
                    .padding(14.dp),
            ) {
                Row {
                    Text(
                        "SCENE ${scene.index}",
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.2.sp,
                        color = DesignTokens.Colors.textTertiary,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        if (selected) "選択中" else "選ぶ",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (selected) scene.accent else DesignTokens.Colors.textSecondary,
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    scene.label,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = scene.accent,
                )
                Text(
                    scene.title,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = DesignTokens.Colors.text,
                )
                Spacer(Modifier.height(4.dp))
                Text(scene.note, fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
                Spacer(Modifier.height(6.dp))
                Text(
                    "${scene.location} ・ ${scene.people} ・ ${scene.budget}",
                    fontSize = 11.sp,
                    color = DesignTokens.Colors.textSecondary,
                )
            }
        }
    }
}
