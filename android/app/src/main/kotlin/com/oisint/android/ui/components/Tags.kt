package com.oisint.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens

/**
 * タグ 4 色トーン。正典は CandidateCard.tsx L26-31 TAG_STYLES
 * （design.html .tag-green / .tag-blue / .tag-orange / .tag-red）。
 * 色ペアは DesignTokens.Extra の tag*Text / tag*Bg に対応。
 */
enum class TagTone { Green, Blue, Orange, Red }

/**
 * ピル型タグ。正典は CandidateCard.tsx L234-244 styles.tag / styles.tagText:
 * minHeight 18 / paddingHorizontal 7 / borderRadius pill / 中央寄せ、
 * fontSize 9 / fontWeight '700'（RN 実測値をそのまま dp/sp 1:1 移植）。
 */
@Composable
fun OisintTag(text: String, tone: TagTone, modifier: Modifier = Modifier) {
    val (textColor, backgroundColor) = when (tone) {
        TagTone.Green -> DesignTokens.Extra.tagGreenText to DesignTokens.Extra.tagGreenBg
        TagTone.Blue -> DesignTokens.Extra.tagBlueText to DesignTokens.Extra.tagBlueBg
        TagTone.Orange -> DesignTokens.Extra.tagOrangeText to DesignTokens.Extra.tagOrangeBg
        TagTone.Red -> DesignTokens.Extra.tagRedText to DesignTokens.Extra.tagRedBg
    }
    Box(
        modifier = modifier
            .defaultMinSize(minHeight = 18.dp)
            .background(backgroundColor, RoundedCornerShape(DesignTokens.Radius.pill))
            .padding(horizontal = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = textColor,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}
