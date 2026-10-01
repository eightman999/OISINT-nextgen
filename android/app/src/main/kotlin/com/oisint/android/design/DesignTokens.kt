package com.oisint.android.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * デザイントークン。正典は `src/theme.ts`。
 * キー名・値を theme.ts と同一に保つ（DesignTokensParityTest が theme.ts を実読して機械照合する。
 * Issue #209 完了条件 7。キー数はハードコードせず theme.ts の実測値と突合する。#485）。
 * theme.ts に無い追加値は [Spacing] / [Extra] に分離（照合対象外。出典コメント付き）。
 */
object DesignTokens {

    /** theme.ts `colors`（宣言順。キー数は DesignTokensParityTest が theme.ts 実測と照合） */
    object Colors {
        val bg = Color(0xFFF1ECE2)
        val canvas = Color(0xFFFBF8F1)
        val surface = Color(0xFFFFFDF8)
        val surfaceSoft = Color(0xFFE9E1D4)
        val surfaceQuiet = Color(0xFFFCFBF8)
        val surfaceDisabled = Color(0xFFF1F1F1)

        // 純白 / 純黒。surface（#fffdf8）/ black（#1d2923 の墨色）とは意味が違う（theme.ts のコメント。#219）
        val white = Color(0xFFFFFFFF)
        val pureBlack = Color(0xFF000000)

        val text = Color(0xFF1D2923)
        val textSecondary = Color(0xFF4F5C55)
        val textTertiary = Color(0xFF59655E)
        val textOnColorDark = Color(0xFF101713)
        val placeholder = Color(0xFF9CA3AF)

        val border = Color(0xFFD4C9B8)
        val borderSoft = Color(0xFFE5DBCD)

        val black = Color(0xFF1D2923)
        val blackHover = Color(0xFF33463B)

        val orange = Color(0xFFB23915)
        val orangeHover = Color(0xFF922D10)
        val orangeSoft = Color(0xFFFFB19A)
        val orangeFaint = Color(0xFFFFF5F0)
        val amber = Color(0xFFC9953B)
        val red = Color(0xFFC9574D)

        val success = Color(0xFF2C9A66)
        val successSoft = Color(0xFFE8F5EE)
        val warning = Color(0xFF8A5700)
        val warningSoft = Color(0xFFFFF3D9)
        val danger = Color(0xFFE14D4D)
        val dangerSoft = Color(0xFFFDEAEA)
        val info = Color(0xFF1D5FA8)
        val infoSoft = Color(0xFFEEF5FB)
        val googleBlue = Color(0xFF4285F4)
        val googleSoft = Color(0xFFF1F5FB)
        val importSoft = Color(0xFFF4F8FC)
        val hearingSoft = Color(0xFFF3F8FC)

        val chipBg = Color(0xFFFAF5EC)
        val sidebarBg = Color(0xFFF4EDE1)
        val activeBg = Color(0xFFFCE9DC)

        /** 照合テスト用: theme.ts と同名キー順の全一覧 */
        val all: List<Pair<String, Color>> = listOf(
            "bg" to bg,
            "canvas" to canvas,
            "surface" to surface,
            "surfaceSoft" to surfaceSoft,
            "surfaceQuiet" to surfaceQuiet,
            "surfaceDisabled" to surfaceDisabled,
            "white" to white,
            "pureBlack" to pureBlack,
            "text" to text,
            "textSecondary" to textSecondary,
            "textTertiary" to textTertiary,
            "textOnColorDark" to textOnColorDark,
            "placeholder" to placeholder,
            "border" to border,
            "borderSoft" to borderSoft,
            "black" to black,
            "blackHover" to blackHover,
            "orange" to orange,
            "orangeHover" to orangeHover,
            "orangeSoft" to orangeSoft,
            "orangeFaint" to orangeFaint,
            "amber" to amber,
            "red" to red,
            "success" to success,
            "successSoft" to successSoft,
            "warning" to warning,
            "warningSoft" to warningSoft,
            "danger" to danger,
            "dangerSoft" to dangerSoft,
            "info" to info,
            "infoSoft" to infoSoft,
            "googleBlue" to googleBlue,
            "googleSoft" to googleSoft,
            "importSoft" to importSoft,
            "hearingSoft" to hearingSoft,
            "chipBg" to chipBg,
            "sidebarBg" to sidebarBg,
            "activeBg" to activeBg,
        )
    }

    /** theme.ts L38 `rankColors`（1 位〜5 位） */
    val rankColors: List<Color> = listOf(
        Color(0xFFD99A00),
        Color(0xFFEF3E3E),
        Color(0xFFEF5A18),
        Color(0xFF83ABB2),
        Color(0xFFE2A65E),
    )

    /** theme.ts L40-42 `rankColor(rank)`: rank を 1..5 に clamp */
    fun rankColor(rank: Int): Color =
        rankColors[rank.coerceIn(1, rankColors.size) - 1]

    /** theme.ts L44-51 `radius`（6 キー。CSS px → dp 1:1。計画書 §3.2） */
    object Radius {
        val xs: Dp = 6.dp
        val sm: Dp = 9.dp
        val md: Dp = 12.dp
        val lg: Dp = 16.dp
        val xl: Dp = 22.dp
        val pill: Dp = 999.dp

        /** 照合テスト用: theme.ts と同名キー順の全一覧 */
        val all: List<Pair<String, Dp>> = listOf(
            "xs" to xs,
            "sm" to sm,
            "md" to md,
            "lg" to lg,
            "xl" to xl,
            "pill" to pill,
        )
    }

    /**
     * theme.ts L60-77 `genreColorMap`（16 エントリ）。
     * 部分一致・先勝ちのため宣言順を保存した List（Map にしない。計画書 §1.7）。
     */
    val genreColorMap: List<Pair<String, Color>> = listOf(
        "ラーメン" to Color(0xFFF6A636),
        "つけ麺" to Color(0xFFF6A636),
        "バーガー" to Color(0xFFC77947),
        "アメリカン" to Color(0xFFC77947),
        "寿司" to Color(0xFFE84C4C),
        "カフェ" to Color(0xFFD4B996),
        "パンケーキ" to Color(0xFFD4B996),
        "ピザ" to Color(0xFFF4C430),
        "イタリアン" to Color(0xFFF4C430),
        "居酒屋" to Color(0xFF7CB0B5),
        "焼鳥" to Color(0xFF7CB0B5),
        "焼肉" to Color(0xFFB94D4D),
        "ステーキ" to Color(0xFFB94D4D),
        "ファミレス" to Color(0xFF7CB87C),
        "定食" to Color(0xFF6C9BD1),
        "フレンチ" to Color(0xFF2A2A2A),
    )

    /** theme.ts L85 fallback（未一致） */
    val genreFallbackColor: Color = Color(0xFF83ABB2)

    /** theme.ts L79-86 `genreColor(genre)`: includes 部分一致・先勝ち + fallback */
    fun genreColor(genre: String?): Color {
        if (!genre.isNullOrEmpty()) {
            for ((key, color) in genreColorMap) {
                if (genre.contains(key)) return color
            }
        }
        return genreFallbackColor
    }

    /**
     * theme.ts に無い spacing。出典: docs/design/OISINT_UI_HTML_CSS_design_spec.md L143-154
     * （space-1..10 / sidebar-width / mobile-width）。照合テスト対象外。
     */
    object Spacing {
        val s1: Dp = 4.dp
        val s2: Dp = 8.dp
        val s3: Dp = 12.dp
        val s4: Dp = 16.dp
        val s5: Dp = 20.dp
        val s6: Dp = 24.dp
        val s8: Dp = 32.dp
        val s10: Dp = 40.dp
    }

    /** theme.ts に無い追加値。出典を個別コメントで明記。照合テスト対象外。 */
    object Extra {
        /** design.html L551-569 のタグ 4 色ペア（文字色 / 背景色） */
        val tagGreenText = Color(0xFF277C56)
        val tagGreenBg = Color(0xFFE6F4ED)
        val tagBlueText = Color(0xFF247D86)
        val tagBlueBg = Color(0xFFE5F4F6)
        val tagOrangeText = Color(0xFFD44B22)
        val tagOrangeBg = Color(0xFFFFF0E6)
        val tagRedText = Color(0xFFD74444)
        val tagRedBg = Color(0xFFFDE9E9)

        /** src/components/MemberList.tsx L35 のアバター 5 色 */
        val avatarColors: List<Color> = listOf(
            Color(0xFFF4A000),
            Color(0xFFF4511E),
            Color(0xFF2C9A66),
            Color(0xFF1D5FA8),
            Color(0xFF83ABB2),
        )
    }
}
