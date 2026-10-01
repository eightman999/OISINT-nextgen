package com.oisint.android

import org.junit.Assert.assertEquals
import org.junit.Test

/** Release variantの実際のunit-test source setでfixture混入を固定する。 */
class ReleaseBuildPolicyTest {
    @Test
    fun releaseAlwaysUsesLiveProviderBoundary() {
        assertEquals("live", BuildConfig.DATA_PROVIDER_MODE)
    }
}
