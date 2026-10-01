package com.oisint.android.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * Material3 テーマの上書き（計画書 §3.4）。
 * - lightColorScheme の全スロットを Web トークンで明示指定し、Material3 デフォルト配色を使わない。
 * - dynamicColor（Material You）不使用。isSystemInDarkTheme() にも追従しない
 *   （正典にダークパレットが存在しないため。§3.7 ライトパレット固定）。
 *
 * スロット対応の根拠:
 * - primary=black: design.html の主ボタン（.search-button）は黒背景・白文字
 * - secondary=orange: アクセント色（捜査開始 hover / アクティブ状態 = colors.orange）
 * - secondaryContainer=activeBg / onSecondaryContainer=orange: 選択チップの配色
 *   （FILTER_CHIPS アクティブ時 activeBg 背景 + orange 文字）
 * - tertiary=amber: ランク 1 位系の強調色
 * - background=bg / surface=surface / surfaceVariant=surfaceSoft: theme.ts の面色 3 種
 * - error=danger / errorContainer=dangerSoft: theme.ts の danger 系
 * - outline=border / outlineVariant=borderSoft: theme.ts の border 系
 * - surfaceTint=surface(白): tonal elevation による色被りを起こさない（Web のカードは純白）
 */
private val OisintLightColorScheme = lightColorScheme(
    primary = DesignTokens.Colors.black,
    onPrimary = DesignTokens.Colors.surface,
    primaryContainer = DesignTokens.Colors.surfaceSoft,
    onPrimaryContainer = DesignTokens.Colors.black,
    inversePrimary = DesignTokens.Colors.surface,
    secondary = DesignTokens.Colors.orange,
    onSecondary = DesignTokens.Colors.surface,
    secondaryContainer = DesignTokens.Colors.activeBg,
    onSecondaryContainer = DesignTokens.Colors.orange,
    tertiary = DesignTokens.Colors.amber,
    onTertiary = DesignTokens.Colors.black,
    tertiaryContainer = DesignTokens.Colors.warningSoft,
    onTertiaryContainer = DesignTokens.Colors.warning,
    background = DesignTokens.Colors.bg,
    onBackground = DesignTokens.Colors.text,
    surface = DesignTokens.Colors.surface,
    onSurface = DesignTokens.Colors.text,
    surfaceVariant = DesignTokens.Colors.surfaceSoft,
    onSurfaceVariant = DesignTokens.Colors.textSecondary,
    surfaceTint = DesignTokens.Colors.surface,
    inverseSurface = DesignTokens.Colors.black,
    inverseOnSurface = DesignTokens.Colors.surface,
    error = DesignTokens.Colors.danger,
    onError = DesignTokens.Colors.surface,
    errorContainer = DesignTokens.Colors.dangerSoft,
    onErrorContainer = DesignTokens.Colors.danger,
    outline = DesignTokens.Colors.border,
    outlineVariant = DesignTokens.Colors.borderSoft,
    scrim = DesignTokens.Colors.black,
)

/** Shapes は DesignTokens.Radius 由来（small=9 / medium=12 / large=16。計画書 §3.4） */
private val OisintShapes = Shapes(
    extraSmall = RoundedCornerShape(DesignTokens.Radius.xs),
    small = RoundedCornerShape(DesignTokens.Radius.sm),
    medium = RoundedCornerShape(DesignTokens.Radius.md),
    large = RoundedCornerShape(DesignTokens.Radius.lg),
    extraLarge = RoundedCornerShape(DesignTokens.Radius.xl),
)

@Composable
fun OisintTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = OisintLightColorScheme,
        shapes = OisintShapes,
        content = content,
    )
}
