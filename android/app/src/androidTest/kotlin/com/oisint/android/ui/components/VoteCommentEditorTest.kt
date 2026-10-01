package com.oisint.android.ui.components

import com.oisint.android.R
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.oisint.android.design.OisintTheme
import com.oisint.android.model.VoteValue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 候補詳細のコメント入力・票操作が同じ callback へ正規化済み値を渡すことを検証する。 */
@RunWith(AndroidJUnit4::class)
class VoteCommentEditorTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun selectingVoteSavesTrimmedDraft() {
        val saved = mutableListOf<Pair<VoteValue, String?>>()
        composeRule.setContent {
            OisintTheme {
                VoteCommentEditor(
                    candidateId = "candidate-1",
                    currentVote = null,
                    initialComment = null,
                    onVote = {},
                    onVoteWithComment = { value, comment -> saved += value to comment },
                )
            }
        }

        composeRule.onNodeWithTag("vote-comment-input").performTextInput("  辛い料理が多そう  ")
        // 票ボタンのラベルは端末ロケールで変わるため string resource から引く
        val wantLabel = InstrumentationRegistry.getInstrumentation().targetContext.getString(R.string.vote_want)
        composeRule.onNodeWithContentDescription(wantLabel).performClick()

        composeRule.runOnIdle {
            assertEquals(listOf(1 to "辛い料理が多そう"), saved)
        }
    }

    @Test
    fun savingBlankDraftClearsExistingComment() {
        val saved = mutableListOf<Pair<VoteValue, String?>>()
        composeRule.setContent {
            OisintTheme {
                VoteCommentEditor(
                    candidateId = "candidate-1",
                    currentVote = 1,
                    initialComment = "既存コメント",
                    onVote = {},
                    onVoteWithComment = { value, comment -> saved += value to comment },
                )
            }
        }

        composeRule.onNodeWithTag("vote-comment-input").performTextClearance()
        composeRule.onNodeWithTag("vote-comment-save").performClick()

        composeRule.runOnIdle {
            assertEquals(listOf(1 to null), saved)
        }
    }
}
