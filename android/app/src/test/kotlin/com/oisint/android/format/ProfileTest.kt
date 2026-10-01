package com.oisint.android.format

import com.oisint.android.model.LocationSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ProfileTest {

    @Test
    fun nullLocationIsNotAddedToQuery() {
        assertNull(Profile.locationToQuery(null))
    }

    @Test
    fun manualLocationUsesItsLabel() {
        assertEquals(
            "場所: 池袋駅",
            Profile.locationToQuery(LocationSelection(label = "池袋駅", source = "map")),
        )
    }

    @Test
    fun gpsLocationUsesPrivateCurrentAreaLabel() {
        val query = Profile.locationToQuery(
            LocationSelection(
                label = "現在地付近",
                source = "gps",
                latitude = 35.681236,
                longitude = 139.767125,
            ),
        )

        assertEquals("場所: 現在地付近", query)
        assertFalse(query!!.contains("35.681236"))
        assertFalse(query.contains("139.767125"))
    }

    @Test
    fun gpsWithoutCoordinatesFallsBackToItsLabel() {
        assertEquals(
            "場所: 取得済みの場所",
            Profile.locationToQuery(LocationSelection(label = "取得済みの場所", source = "gps")),
        )
    }
}
