package com.oisint.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens
import com.oisint.android.model.InvestigationMember

/**
 * 参加メンバーの重ねアバター表示。正典は src/components/MemberList.tsx。
 *
 * レイアウト移植（MemberList.tsx styles）:
 * - container L38-42: Row・中央揃え・gap 10
 * - avatar L47-56: 28x28 / radius pill / bg avatarColors[index % 5]（L19・L35）/
 *   border 2 surface / 中央に displayName 先頭 1 文字（L23-25: 白・12sp・'700'）
 * - avatarOverlap L57-59: 2 個目以降 marginLeft -8（負の間隔で重ね、後勝ちで前面）
 * - onlineDot L65-75: isOnline のとき右下 (right -1 / bottom -1) に 8x8 の正円、
 *   bg success / border 1 surface
 * - count L76-79: 「{N}人が参加中」12sp textSecondary（testID "member-count"、L30）
 */
@Composable
fun MemberRow(members: List<InvestigationMember>, modifier: Modifier = Modifier) {
    val pill = RoundedCornerShape(DesignTokens.Radius.pill)
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            // marginLeft -8 相当。後の要素ほど前面に描画されるのも RN と同じ
            horizontalArrangement = Arrangement.spacedBy((-8).dp),
        ) {
            members.forEachIndexed { index, member ->
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(
                            DesignTokens.Extra.avatarColors[index % DesignTokens.Extra.avatarColors.size],
                            pill,
                        )
                        .border(2.dp, DesignTokens.Colors.surface, pill),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        member.displayName.take(1),
                        color = DesignTokens.Colors.surface,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    if (member.isOnline == true) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .offset(x = 1.dp, y = 1.dp)
                                .size(8.dp)
                                .background(DesignTokens.Colors.success, pill)
                                .border(1.dp, DesignTokens.Colors.surface, pill),
                        )
                    }
                }
            }
        }
        Text(
            "${members.size}人が参加中",
            modifier = Modifier.testTag("member-count"),
            fontSize = 12.sp,
            color = DesignTokens.Colors.textSecondary,
        )
    }
}
