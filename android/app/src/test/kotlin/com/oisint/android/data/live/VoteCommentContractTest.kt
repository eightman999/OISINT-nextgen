package com.oisint.android.data.live

import com.oisint.android.data.normalizeVoteComment
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** votes.comment の trim / NULL と live upsert wire 形状を回帰検証する。 */
class VoteCommentContractTest {

    @Test
    fun normalizeVoteCommentTrimsAndMapsBlankToNull() {
        assertEquals("候補の理由", normalizeVoteComment("  候補の理由  "))
        assertNull(normalizeVoteComment(" \t\n "))
        assertNull(normalizeVoteComment(null))
    }

    @Test
    fun liveVoteUpsertKeepsExplicitNullForCommentDeletion() {
        val encoded = Json.encodeToString(
            LiveDataProvider.VoteUpsert.serializer(),
            LiveDataProvider.VoteUpsert(
                investigationId = "investigation-1",
                candidateId = "candidate-1",
                userId = "user-1",
                value = 0,
                comment = normalizeVoteComment("  "),
            ),
        )
        val payload = Json.parseToJsonElement(encoded).jsonObject
        assertEquals("investigation-1", payload["investigation_id"]?.jsonPrimitive?.content)
        assertEquals("candidate-1", payload["candidate_id"]?.jsonPrimitive?.content)
        assertTrue("コメント削除時は JSON null を送る", payload.containsKey("comment"))
        assertTrue(payload["comment"]?.toString() == "null")
    }
}
