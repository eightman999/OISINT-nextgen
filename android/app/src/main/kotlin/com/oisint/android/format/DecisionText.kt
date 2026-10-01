package com.oisint.android.format

import com.oisint.android.model.Candidate
import com.oisint.android.model.Evidence
import com.oisint.android.model.Investigation
import com.oisint.android.model.MatchState
import com.oisint.android.model.Requirement
import java.net.URI

/**
 * 決定テキスト生成。正典は `src/lib/decisionText.ts`（209 行の 1:1 移植）。
 * 同一入力 → 同一出力の golden テスト（DecisionTextTest）で正典との一致を検証する。
 */
object DecisionText {

    private const val UNKNOWN = "不明"
    private const val UNKNOWN_SOURCE = "出典不明"
    private const val MAX_REJECTED_CANDIDATES = 2
    private const val MAX_PHONE_QUESTIONS = 3

    /** decisionText.ts L9-18 */
    data class Options(
        val dateTime: String? = null,
        val phoneNumber: String? = null,
        val mapUrl: String? = null,
        val reason: String? = null,
        val reasons: List<String>? = null,
        val phoneQuestions: List<String>? = null,
        val verificationUrl: String? = null,
    )

    /** decisionText.ts L20-24 */
    data class Result(val short: String, val detailed: String)

    /** decisionText.ts L35-38 */
    private fun nonEmpty(value: String?): String? {
        val trimmed = value?.trim()
        return if (trimmed.isNullOrEmpty()) null else trimmed
    }

    /** decisionText.ts L40-42 */
    private fun valueOrUnknown(value: String?): String = nonEmpty(value) ?: UNKNOWN

    /** decisionText.ts L44-54（http/https のみ許可。JS の new URL 失敗 = null と同じ挙動） */
    private fun httpUrlOrUndefined(value: String?): String? {
        val candidate = nonEmpty(value) ?: return null
        return try {
            val scheme = URI(candidate).scheme?.lowercase()
            if (scheme == "http" || scheme == "https") candidate else null
        } catch (_: Exception) {
            null
        }
    }

    /** decisionText.ts L56-65（hostname の www. を除去） */
    private fun sourceDomain(sourceUrl: String?): String {
        val url = httpUrlOrUndefined(sourceUrl) ?: return UNKNOWN_SOURCE
        return try {
            val host = URI(url).host ?: return UNKNOWN_SOURCE
            host.replace(Regex("^www\\.", RegexOption.IGNORE_CASE), "").ifEmpty { UNKNOWN_SOURCE }
        } catch (_: Exception) {
            UNKNOWN_SOURCE
        }
    }

    /** decisionText.ts L67-71 */
    private fun evidenceForEvaluation(candidate: Candidate, evidenceIds: List<String>): Evidence? =
        evidenceIds.firstNotNullOfOrNull { id -> candidate.evidence.firstOrNull { it.id == id } }

    /** decisionText.ts L73-84 */
    private fun evaluationReason(candidate: Candidate, states: List<MatchState>): String? {
        val evaluation = candidate.evaluations.firstOrNull { entry ->
            states.contains(entry.state) && nonEmpty(entry.explanation) != null
        } ?: return null
        val explanation = nonEmpty(evaluation.explanation) ?: return null
        val evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds)
        return "$explanation（${sourceDomain(evidence?.sourceUrl)}）"
    }

    /** decisionText.ts L86-96 */
    private fun evidenceBackedReasons(candidate: Candidate): List<String> =
        candidate.evaluations.flatMap { evaluation ->
            if (evaluation.state != MatchState.Match && evaluation.state != MatchState.Partial) {
                return@flatMap emptyList<String>()
            }
            val explanation = nonEmpty(evaluation.explanation)
            val evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds)
            if (explanation == null || evidence == null) {
                emptyList()
            } else {
                listOf("$explanation（${sourceDomain(evidence.sourceUrl)}）")
            }
        }

    /** decisionText.ts L98-116（3 行固定。優先順: reasons > reason > 生成） */
    private fun reasonLines(candidate: Candidate, options: Options): List<String> {
        val suppliedReasons = (options.reasons ?: emptyList())
            .mapNotNull { nonEmpty(it) }
            .map { "$it（$UNKNOWN_SOURCE）" }
        val generatedReasons = evidenceBackedReasons(candidate)
        val oneLineReason = nonEmpty(options.reason)
        val reasons = when {
            suppliedReasons.isNotEmpty() -> suppliedReasons
            oneLineReason != null -> listOf("$oneLineReason（$UNKNOWN_SOURCE）")
            else -> generatedReasons
        }
        val safeReasons = reasons.ifEmpty {
            listOf("根拠を確認できる情報は$UNKNOWN（$UNKNOWN_SOURCE）")
        }
        return (0 until 3).map { index ->
            safeReasons.getOrNull(index) ?: "追加の選定理由は$UNKNOWN（$UNKNOWN_SOURCE）"
        }
    }

    /** decisionText.ts L118-127（評価が無い or unknown の条件） */
    private fun unknownRequirements(investigation: Investigation, candidate: Candidate): List<Requirement> {
        val evaluationsByRequirement = candidate.evaluations.associateBy { it.requirementId }
        return investigation.requirements.filter { requirement ->
            val evaluation = evaluationsByRequirement[requirement.id]
            evaluation == null || evaluation.state == MatchState.Unknown
        }
    }

    /** decisionText.ts L129-144（最大 3 件） */
    private fun phoneQuestions(unknowns: List<Requirement>, options: Options): List<String> {
        val suppliedQuestions = (options.phoneQuestions ?: emptyList())
            .mapNotNull { nonEmpty(it) }
            .take(MAX_PHONE_QUESTIONS)
        if (suppliedQuestions.isNotEmpty()) return suppliedQuestions
        return unknowns
            .mapNotNull { nonEmpty(it.text) }
            .map { "「$it」について確認する" }
            .take(MAX_PHONE_QUESTIONS)
    }

    /** decisionText.ts L146-149 */
    private fun rejectedReason(candidate: Candidate): String {
        val reason = evaluationReason(
            candidate,
            listOf(MatchState.Mismatch, MatchState.Partial, MatchState.Unknown),
        )
        return if (reason != null) "判定理由: $reason" else "判定理由は$UNKNOWN（$UNKNOWN_SOURCE）"
    }

    /** decisionText.ts L155-209 */
    fun generateDecisionText(
        investigation: Investigation,
        selectedCandidate: Candidate,
        options: Options = Options(),
    ): Result {
        val address = valueOrUnknown(selectedCandidate.place.address)
        val dateTime = valueOrUnknown(options.dateTime)
        val phoneNumber = valueOrUnknown(options.phoneNumber)
        val mapUrl = httpUrlOrUndefined(options.mapUrl) ?: UNKNOWN
        val verificationUrl = httpUrlOrUndefined(options.verificationUrl)
            ?: httpUrlOrUndefined(selectedCandidate.place.urls?.pc)
            ?: UNKNOWN
        val reasons = reasonLines(selectedCandidate, options)
        val shortReason = "選んだ理由: ${reasons[0]}"
        val unknowns = unknownRequirements(investigation, selectedCandidate)
        val questions = phoneQuestions(unknowns, options)
        val rejected = investigation.candidates
            .filter { it.id != selectedCandidate.id }
            .sortedBy { it.rank }
            .take(MAX_REJECTED_CANDIDATES)

        val short = listOf(
            "店名: ${valueOrUnknown(selectedCandidate.place.name)}",
            "日時・住所: $dateTime / $address",
            "地図リンク: $mapUrl",
            shortReason,
            "電話番号: $phoneNumber",
        ).joinToString("\n")

        val rejectedLines = if (rejected.isNotEmpty()) {
            rejected.map { "・${valueOrUnknown(it.place.name)}: ${rejectedReason(it)}" }
        } else {
            listOf("・比較対象: $UNKNOWN（比較対象なし）")
        }
        val questionLines = if (questions.isNotEmpty()) {
            questions.map { "・$it" }
        } else {
            listOf("・${UNKNOWN}な条件はありません")
        }

        val detailed = (
            listOf(
                "店名: ${valueOrUnknown(selectedCandidate.place.name)}",
                "日時・住所: $dateTime / $address",
                "地図リンク: $mapUrl",
                "選んだ理由: ${reasons[0]}",
                "選んだ理由: ${reasons[1]}",
                "選んだ理由: ${reasons[2]}",
                "落とした2件の理由:",
            ) + rejectedLines + listOf(
                "残る不明: ${unknowns.size}件",
                "店に電話で聞くこと:",
            ) + questionLines + listOf(
                "電話番号: $phoneNumber",
                "検証用URL: $verificationUrl",
            )
            ).joinToString("\n")

        return Result(short, detailed)
    }
}
