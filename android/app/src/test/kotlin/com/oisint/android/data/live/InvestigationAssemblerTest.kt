package com.oisint.android.data.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InvestigationAssemblerTest {

    @Test
    fun liveMemberPresenceIsUnknownUntilRealtimePresenceIsImplemented() {
        val member = mapLiveMember(
            InvestigationAssembler.MemberRow(
                userId = "member-1",
                displayName = "参加者",
                role = "editor",
            ),
        )

        assertEquals("member-1", member.id)
        assertEquals("参加者", member.displayName)
        assertEquals("editor", member.role)
        assertNull(member.isOnline)
    }

    @Test
    fun missingDisplayNameStillUsesGuestLabelWithoutInventingPresence() {
        val member = mapLiveMember(
            InvestigationAssembler.MemberRow(
                userId = "member-2",
                displayName = null,
                role = "viewer",
            ),
        )

        assertEquals("ゲスト", member.displayName)
        assertNull(member.isOnline)
    }

    @Test
    fun livePlaceKeepsAddressButDoesNotInventWalkingAccess() {
        val place = mapLivePlace(
            InvestigationAssembler.PlaceRow(
                id = "place-1",
                name = "候補店",
                address = "東京都豊島区池袋1-2-3",
            ),
            fallbackPlaceId = "place-1",
            genre = "焼肉",
        )

        assertEquals("東京都豊島区池袋1-2-3", place.address)
        assertEquals("焼肉", place.genre)
        assertNull(place.access)
    }

    @Test
    fun voteCommentsIgnoreNullAndBlankValuesAndTrimText() {
        val comments = mapVoteComments(
            listOf(
                InvestigationAssembler.VoteRow("candidate-1", "member-1", 1, "  辛い料理が多そう  "),
                InvestigationAssembler.VoteRow("candidate-1", "member-2", 0, null),
                InvestigationAssembler.VoteRow("candidate-1", "member-3", -1, "   "),
            ),
        )

        assertEquals(mapOf("member-1" to "辛い料理が多そう"), comments)
    }

    @Test
    fun multipleVoteCommentsHaveStableUserOrderRegardlessOfRowOrder() {
        val rows = listOf(
            InvestigationAssembler.VoteRow("candidate-1", "member-2", 0, "  二番目  "),
            InvestigationAssembler.VoteRow("candidate-1", "member-1", 1, " 一番目 "),
        )

        val forward = mapVoteComments(rows)
        val reversed = mapVoteComments(rows.reversed())

        assertEquals(forward, reversed)
        assertEquals(listOf("member-1", "member-2"), forward.keys.toList())
    }
}
