package com.oisint.android.design

import androidx.compose.ui.graphics.toArgb
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * デザイントークン一致テスト（計画書 §5.2 / Issue #209 完了条件 7）。
 * リポジトリ実ファイル `src/theme.ts` をパースし、DesignTokens の全値と機械照合する。
 * theme.ts が見つからない場合は fail（skip にしない。skip は検証空洞化の温床）。
 * ログに `colors.bg: expected #f7f6f3 == actual #f7f6f3` 形式で全行出力する
 * （「差分ゼロのログ添付」はこの出力で満たす）。
 */
class DesignTokensParityTest {

    private fun repoRoot(): File {
        // build.gradle.kts の testOptions が渡す oisint.repo.root を優先し、
        // 無ければ user.dir から親方向へ src/theme.ts を探す（worktree でも動く）
        val propRoot: String? = System.getProperty("oisint.repo.root")
        if (propRoot != null) {
            val dir = File(propRoot)
            if (File(dir, "src/theme.ts").isFile) return dir
        }
        var dir: File? = File(System.getProperty("user.dir"))
        while (dir != null) {
            if (File(dir, "src/theme.ts").isFile) return dir
            dir = dir.parentFile
        }
        fail("リポジトリルート（src/theme.ts のある階層）が見つかりません")
        error("unreachable")
    }

    private fun themeTs(): String {
        val file = File(repoRoot(), "src/theme.ts")
        assertTrue("src/theme.ts が存在しません: ${file.absolutePath}", file.isFile)
        return file.readText()
    }

    private fun colorToHex(color: androidx.compose.ui.graphics.Color): String =
        String.format("#%06x", color.toArgb() and 0xFFFFFF)

    /** `export const colors = { ... } as const;` ブロックから key: '#hex' を宣言順に抽出 */
    private fun parseColors(source: String): List<Pair<String, String>> {
        val block = Regex(
            """export const colors = \{(.*?)\} as const;""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source)?.groupValues?.get(1)
            ?: fail("theme.ts の colors ブロックをパースできません").let { error("unreachable") }
        return Regex("""(\w+):\s*'(#[0-9a-fA-F]{6})'""")
            .findAll(block)
            .map { it.groupValues[1] to it.groupValues[2].lowercase() }
            .toList()
    }

    /** `export const rankColors = ['#..', ...] as const;` を抽出 */
    private fun parseRankColors(source: String): List<String> {
        val block = Regex("""export const rankColors = \[(.*?)\] as const;""")
            .find(source)?.groupValues?.get(1)
            ?: fail("theme.ts の rankColors をパースできません").let { error("unreachable") }
        return Regex("""'(#[0-9a-fA-F]{6})'""").findAll(block)
            .map { it.groupValues[1].lowercase() }.toList()
    }

    /** `export const radius = { ... } as const;` から key: number を抽出 */
    private fun parseRadius(source: String): List<Pair<String, Int>> {
        val block = Regex(
            """export const radius = \{(.*?)\} as const;""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source)?.groupValues?.get(1)
            ?: fail("theme.ts の radius ブロックをパースできません").let { error("unreachable") }
        return Regex("""(\w+):\s*(\d+)""").findAll(block)
            .map { it.groupValues[1] to it.groupValues[2].toInt() }.toList()
    }

    /** `const genreColorMap: [string, string][] = [ ['ジャンル', '#hex'], ... ];` を宣言順に抽出 */
    private fun parseGenreColorMap(source: String): List<Pair<String, String>> {
        val block = Regex(
            """const genreColorMap: \[string, string]\[] = \[(.*?)];""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source)?.groupValues?.get(1)
            ?: fail("theme.ts の genreColorMap をパースできません").let { error("unreachable") }
        return Regex("""\['([^']+)',\s*'(#[0-9a-fA-F]{6})']""").findAll(block)
            .map { it.groupValues[1] to it.groupValues[2].lowercase() }.toList()
    }

    /** genreColor の fallback `return '#83abb2';` を抽出 */
    private fun parseGenreFallback(source: String): String {
        val fn = Regex(
            """export function genreColor.*?return '(#[0-9a-fA-F]{6})';\s*\}""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source)?.groupValues?.get(1)
            ?: fail("theme.ts の genreColor fallback をパースできません").let { error("unreachable") }
        return fn.lowercase()
    }

    @Test
    fun colorsMatchThemeTs() {
        val expected = parseColors(themeTs())
        // キー数はハードコードしない（Web 側の正当な追加で毎回落ちるため。#485）。
        // theme.ts の実測値と DesignTokens.Colors.all の件数一致だけを主張する。
        // 0 件はパーサ破損（regex / ブロック抽出の劣化）とみなして fail-closed。
        assertTrue("theme.ts の colors を 1 件もパースできていません（パーサ破損疑い）", expected.isNotEmpty())
        assertEquals("DesignTokens.Colors.all の件数", expected.size, DesignTokens.Colors.all.size)
        expected.forEachIndexed { i, (key, hex) ->
            val (actualKey, actualColor) = DesignTokens.Colors.all[i]
            val actualHex = colorToHex(actualColor)
            println("colors.$key: expected $hex == actual $actualHex")
            assertEquals("colors[$i] キー名", key, actualKey)
            assertEquals("colors.$key の値", hex, actualHex)
        }
    }

    @Test
    fun rankColorsMatchThemeTs() {
        val expected = parseRankColors(themeTs())
        assertTrue("theme.ts の rankColors を 1 件もパースできていません（パーサ破損疑い）", expected.isNotEmpty())
        assertEquals("DesignTokens.rankColors の件数", expected.size, DesignTokens.rankColors.size)
        expected.forEachIndexed { i, hex ->
            val actualHex = colorToHex(DesignTokens.rankColors[i])
            println("rankColors[$i]: expected $hex == actual $actualHex")
            assertEquals("rankColors[$i]", hex, actualHex)
        }
    }

    @Test
    fun rankColorClampMatchesThemeTs() {
        // theme.ts L40-42: rank を 1..5 に clamp
        assertEquals(DesignTokens.rankColors[0], DesignTokens.rankColor(0))
        assertEquals(DesignTokens.rankColors[0], DesignTokens.rankColor(1))
        assertEquals(DesignTokens.rankColors[4], DesignTokens.rankColor(5))
        assertEquals(DesignTokens.rankColors[4], DesignTokens.rankColor(99))
    }

    @Test
    fun radiusMatchesThemeTs() {
        val expected = parseRadius(themeTs())
        assertTrue("theme.ts の radius を 1 件もパースできていません（パーサ破損疑い）", expected.isNotEmpty())
        assertEquals("DesignTokens.Radius.all の件数", expected.size, DesignTokens.Radius.all.size)
        expected.forEachIndexed { i, (key, value) ->
            val (actualKey, actualDp) = DesignTokens.Radius.all[i]
            println("radius.$key: expected $value == actual ${actualDp.value.toInt()}")
            assertEquals("radius[$i] キー名", key, actualKey)
            assertEquals("radius.$key の値", value, actualDp.value.toInt())
        }
    }

    @Test
    fun genreColorMapMatchesThemeTs() {
        val expected = parseGenreColorMap(themeTs())
        assertTrue("theme.ts の genreColorMap を 1 件もパースできていません（パーサ破損疑い）", expected.isNotEmpty())
        assertEquals("DesignTokens.genreColorMap の件数", expected.size, DesignTokens.genreColorMap.size)
        expected.forEachIndexed { i, (genre, hex) ->
            val (actualGenre, actualColor) = DesignTokens.genreColorMap[i]
            val actualHex = colorToHex(actualColor)
            println("genreColorMap[$genre]: expected $hex == actual $actualHex")
            assertEquals("genreColorMap[$i] ジャンル名（宣言順）", genre, actualGenre)
            assertEquals("genreColorMap[$genre] の値", hex, actualHex)
        }
        val fallback = parseGenreFallback(themeTs())
        val actualFallback = colorToHex(DesignTokens.genreFallbackColor)
        println("genreColor fallback: expected $fallback == actual $actualFallback")
        assertEquals("genreColor fallback", fallback, actualFallback)
    }

    @Test
    fun genreColorBehaviorMatchesThemeTs() {
        // theme.ts L79-86: includes 部分一致・先勝ち + fallback
        assertEquals(DesignTokens.genreColorMap[0].second, DesignTokens.genreColor("ラーメン"))
        // 部分一致（「焼肉・ホルモン」は「焼肉」に一致）
        assertEquals(
            DesignTokens.genreColorMap.first { it.first == "焼肉" }.second,
            DesignTokens.genreColor("焼肉・ホルモン"),
        )
        // 未一致 / null は fallback
        assertEquals(DesignTokens.genreFallbackColor, DesignTokens.genreColor("中華"))
        assertEquals(DesignTokens.genreFallbackColor, DesignTokens.genreColor(null))
    }
}
