package com.oisint.android.design

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import com.oisint.android.R

/**
 * フォント方針（計画書 §3.6）:
 * - brand 系（ロゴ・ランク数字・スコア・match 記号）にのみ Manrope（可変フォント）を同梱。
 *   出典: design.html .logo / .rank-badge / .match は Manrope 指定。OFL ライセンス
 *   （app/src/main/assets/OFL-Manrope.txt）。
 * - ui 系はシステムフォント（Android の日本語システムフォントは Noto Sans CJK 系で
 *   デザイン正典の ui 指定 "Noto Sans JP", system-ui と実質同等）。
 */
@OptIn(ExperimentalTextApi::class)
val ManropeFamily: FontFamily = FontFamily(
    Font(
        R.font.manrope,
        weight = FontWeight.Normal,
        variationSettings = FontVariation.Settings(FontVariation.weight(400)),
    ),
    Font(
        R.font.manrope,
        weight = FontWeight.Medium,
        variationSettings = FontVariation.Settings(FontVariation.weight(500)),
    ),
    Font(
        R.font.manrope,
        weight = FontWeight.SemiBold,
        variationSettings = FontVariation.Settings(FontVariation.weight(600)),
    ),
    Font(
        R.font.manrope,
        weight = FontWeight.Bold,
        variationSettings = FontVariation.Settings(FontVariation.weight(700)),
    ),
    Font(
        R.font.manrope,
        weight = FontWeight.ExtraBold,
        variationSettings = FontVariation.Settings(FontVariation.weight(800)),
    ),
)
