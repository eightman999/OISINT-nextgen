package com.oisint.android

import com.oisint.android.testing.StringResources
import com.oisint.android.ui.paywall.BillingPeriod
import com.oisint.android.ui.paywall.parseBillingPeriod
import com.oisint.android.ui.paywall.planTitleRes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 既定（日本語）と英語の string resource が同じキー・同じ書式引数を持つことを検証する。 */
class LocalizationParityTest {

    private val formatArg = Regex("""%(\d+\$)?[sd]""")

    @Test
    fun englishCoversEveryTranslatableJapaneseString() {
        val missing = StringResources.jaNames() - StringResources.enNames() - setOf("app_name")
        assertTrue("values-en/strings.xml に無いキー: $missing", missing.isEmpty())
        val extra = StringResources.enNames() - StringResources.jaNames()
        assertTrue("values/strings.xml に無いキー: $extra", extra.isEmpty())
    }

    @Test
    fun formatArgumentsMatchBetweenLocales() {
        val ids = R.string::class.java.fields.map { it.getInt(null) }
        ids.forEach { id ->
            val name = StringResources.nameOf(id)
            if (name !in StringResources.jaNames() || name !in StringResources.enNames()) return@forEach
            val ja = formatArg.findAll(StringResources.ja(id)).map { it.value }.sorted().toList()
            val en = formatArg.findAll(StringResources.en(id)).map { it.value }.sorted().toList()
            assertEquals("$name の書式引数", ja, en)
        }
    }

    @Test
    fun paywallShowsLocalizedPlanTitleAndDuration() {
        assertEquals(R.string.paywall_plan_monthly, planTitleRes("oisint_plus_monthly"))
        assertEquals(R.string.paywall_plan_monthly, planTitleRes("oisint_plus_monthly:monthly2"))
        assertEquals(R.string.paywall_plan_annual, planTitleRes("oisint_plus_annual:2annual"))
        assertNull(planTitleRes("unknown"))
        assertEquals("OISINT Plus Monthly", StringResources.en(R.string.paywall_plan_monthly))
        assertEquals("OISINT Plus 月額", StringResources.ja(R.string.paywall_plan_monthly))

        assertEquals(BillingPeriod('M', 1), parseBillingPeriod("P1M"))
        assertEquals(BillingPeriod('Y', 1), parseBillingPeriod("P1Y"))
        assertEquals(BillingPeriod('W', 2), parseBillingPeriod("P2W"))
        assertNull(parseBillingPeriod(""))
        assertNull(parseBillingPeriod("P1Y2M"))
    }
}
