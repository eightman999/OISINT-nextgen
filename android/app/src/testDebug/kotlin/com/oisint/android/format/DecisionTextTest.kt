package com.oisint.android.format

import com.oisint.android.testing.StringResources
import com.oisint.android.data.mock.MockData
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * decisionText.ts との golden テスト（同一入力 → 同一出力。Phase 4 完了条件の生成文検証）。
 * 期待値は src/lib/decisionText.ts L155-209 のテンプレートへ mock 店 A/B/C を手で通した結果
 * （evidenceBackedReasons: match/partial かつ explanation 非空かつ evidence 実在のみ採用）。
 */
class DecisionTextTest {

    /** 既定ロケール（values/strings.xml = 日本語）の定型文。Web 正典の日本語と逐語照合する。 */
    private val JA = DecisionText.Labels.from(StringResources::ja)

    @Test
    fun goldenShortForMockStoreA() {
        val inv = MockData.mockInvestigation
        val storeA = inv.candidates.first { it.id == "c-1" }
        val result = DecisionText.generateDecisionText(inv, storeA, JA)

        val expectedShort = listOf(
            "店名: 店A",
            "日時・住所: 不明 / 東京都豊島区池袋1-2-3",
            "地図リンク: 不明",
            "選んだ理由: 池袋駅東口から徒歩5分（example.com）",
            "電話番号: 不明",
        ).joinToString("\n")
        assertEquals(expectedShort, result.short)
    }

    @Test
    fun goldenDetailedForMockStoreA() {
        val inv = MockData.mockInvestigation
        val storeA = inv.candidates.first { it.id == "c-1" }
        val result = DecisionText.generateDecisionText(inv, storeA, JA)

        val expectedDetailed = listOf(
            "店名: 店A",
            "日時・住所: 不明 / 東京都豊島区池袋1-2-3",
            "地図リンク: 不明",
            "選んだ理由: 池袋駅東口から徒歩5分（example.com）",
            "選んだ理由: ディナー 2500〜3500円（example.com）",
            "選んだ理由: 焼肉メニューあり（example.com）",
            "落とした2件の理由:",
            "・店B: 判定理由: 予算 3000〜4000円でやや高め（出典不明）",
            "・店C: 判定理由: 支払い情報が見つからない（出典不明）",
            "残る不明: 0件",
            "店に電話で聞くこと:",
            "・不明な条件はありません",
            "電話番号: 不明",
            "検証用URL: https://example.com/shop-a",
        ).joinToString("\n")
        assertEquals(expectedDetailed, result.detailed)
    }

    @Test
    fun goldenDetailedForStoreCWithUnknownRequirement() {
        val inv = MockData.mockInvestigation
        // 店 C は evidence 0 件 → 生成理由なし → フォールバック文。r-4 が unknown → 電話質問 1 件
        val storeC = inv.candidates.first { it.id == "c-3" }
        val result = DecisionText.generateDecisionText(inv, storeC, JA)

        val expectedDetailed = listOf(
            "店名: 店C",
            "日時・住所: 不明 / 東京都豊島区池袋7-8-9",
            "地図リンク: 不明",
            "選んだ理由: 根拠を確認できる情報は不明（出典不明）",
            "選んだ理由: 追加の選定理由は不明（出典不明）",
            "選んだ理由: 追加の選定理由は不明（出典不明）",
            "落とした2件の理由:",
            "・店A: 判定理由: レビューは静かとあり、公式には明記なし（tabelog.com）",
            "・店B: 判定理由: 予算 3000〜4000円でやや高め（出典不明）",
            "残る不明: 1件",
            "店に電話で聞くこと:",
            "・「カード可」について確認する",
            "電話番号: 不明",
            "検証用URL: https://example.com/shop-c",
        ).joinToString("\n")
        assertEquals(expectedDetailed, result.detailed)
    }

    @Test
    fun optionsOverrideGeneratedValues() {
        val inv = MockData.mockInvestigation
        val storeA = inv.candidates.first { it.id == "c-1" }
        val result = DecisionText.generateDecisionText(
            inv,
            storeA,
            JA,
            DecisionText.Options(
                dateTime = "8/23 19:00",
                phoneNumber = "03-1234-5678",
                mapUrl = "https://maps.example.com/a",
                reason = "みんなの合意",
                phoneQuestions = listOf("禁煙席はあるか"),
                verificationUrl = "https://verify.example.com/a",
            ),
        )
        val expectedShort = listOf(
            "店名: 店A",
            "日時・住所: 8/23 19:00 / 東京都豊島区池袋1-2-3",
            "地図リンク: https://maps.example.com/a",
            "選んだ理由: みんなの合意（出典不明）",
            "電話番号: 03-1234-5678",
        ).joinToString("\n")
        assertEquals(expectedShort, result.short)
        // 詳細版の検証URL・電話質問は options 優先
        assert(result.detailed.contains("検証用URL: https://verify.example.com/a"))
        assert(result.detailed.contains("・禁煙席はあるか"))
    }

    @Test
    fun invalidUrlsFallBackToUnknown() {
        val inv = MockData.mockInvestigation
        val storeA = inv.candidates.first { it.id == "c-1" }
        val result = DecisionText.generateDecisionText(
            inv,
            storeA,
            JA,
            // javascript: URL や相対パスは JS の new URL 同様に不採用（http/https のみ）
            DecisionText.Options(mapUrl = "javascript:alert(1)", verificationUrl = "example.com/no-scheme"),
        )
        assert(result.short.contains("地図リンク: 不明"))
        // verificationUrl 不正 → place.urls.pc へフォールバック
        assert(result.detailed.contains("検証用URL: https://example.com/shop-a"))
    }
}
