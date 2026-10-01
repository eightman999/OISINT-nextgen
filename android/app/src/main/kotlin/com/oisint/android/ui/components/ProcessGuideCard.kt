package com.oisint.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.design.DesignTokens

/** index.tsx PROCESS_STEPS（逐語） */
data class ProcessStep(val index: String, val title: String, val text: String)

val PROCESS_STEPS = listOf(
    ProcessStep("01", "場面から書き込む", "人数、予算、空気感。うまく言葉にできない条件も、そのままで。"),
    ProcessStep("02", "候補の裏側を確かめる", "公開情報と出典を並べて、良さそうだけで終わらせない。"),
    ProcessStep("03", "みんなで「これだね」へ", "共有した画面で条件を足し、最後は自分たちの判断で決める。"),
)

/**
 * 「選び方の流れ」カード（index.tsx lp-workbench-aside の内容）。
 *
 * #308: 説明と「調べる」操作を同じ画面に並べない。説明はこのカードとして
 * 独立した about ページに置き、Home には導線だけを残す。
 */
@Composable
fun ProcessGuideCard(modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .testTag("process-guide-card")
            .clip(RoundedCornerShape(4.dp))
            .background(DesignTokens.Colors.surfaceSoft)
            .border(1.dp, DesignTokens.Colors.borderSoft, RoundedCornerShape(4.dp))
            .padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "選び方の流れ",
                fontSize = 10.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.orange,
            )
            Text("↘", fontSize = 20.sp, color = DesignTokens.Colors.orange)
        }
        Text(
            "話しながら、\n候補が見えてくる。",
            fontSize = 24.sp,
            lineHeight = 34.sp,
            fontWeight = FontWeight.ExtraBold,
            color = DesignTokens.Colors.text,
        )
        Text(
            "候補を並べて終わりではなく、条件を持ち寄るたびに「じゃあ、ここはどう？」が見えてくる。",
            fontSize = 11.sp,
            lineHeight = 19.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(DesignTokens.Colors.border),
        )
        PROCESS_STEPS.forEach { step ->
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    step.index,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = DesignTokens.Colors.orange,
                    modifier = Modifier
                        .width(22.dp)
                        .padding(top = 1.dp),
                )
                Spacer(Modifier.width(12.dp))
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        step.title,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = DesignTokens.Colors.text,
                    )
                    Text(
                        step.text,
                        fontSize = 11.sp,
                        lineHeight = 18.sp,
                        color = DesignTokens.Colors.textSecondary,
                    )
                }
            }
        }
        Box(
            Modifier
                .border(1.dp, DesignTokens.Colors.border, RoundedCornerShape(2.dp))
                .padding(horizontal = 9.dp, vertical = 6.dp),
        ) {
            Text(
                "理由を見ながら、ちゃんと決める",
                fontSize = 9.sp,
                fontWeight = FontWeight.ExtraBold,
                color = DesignTokens.Colors.textSecondary,
            )
        }
    }
}
