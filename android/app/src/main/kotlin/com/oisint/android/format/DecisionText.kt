package com.oisint.android.format

import java.util.Locale
import com.oisint.android.R
import com.oisint.android.model.Candidate
import com.oisint.android.model.Evidence
import com.oisint.android.model.Investigation
import com.oisint.android.model.MatchState
import com.oisint.android.model.Requirement
import java.net.URI

/**
 * 決定テキスト生成。正典は `src/lib/decisionText.ts`（209 行の 1:1 移植）。
 * 同一入力 → 同一出力の golden テスト（DecisionTextTest）で正典との一致を検証する。
 * 定型文は [Labels]（string resource 由来）で受け取り、日本語は values/strings.xml に逐語で保持する。
 * 店名・Evidence の説明文などサーバ由来の内容は翻訳しない。
 */
object DecisionText {

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

    /** 定型文テンプレート。`%1$s` 等の書式は string resource と同じ。 */
    data class Labels(
        val unknown: String,
        val unknownSource: String,
        val reasonWithSource: String,
        val reasonNone: String,
        val reasonExtraNone: String,
        val phoneQuestion: String,
        val rejectedReason: String,
        val rejectedReasonUnknown: String,
        val selectedReason: String,
        val storeName: String,
        val dateTimeAddress: String,
        val mapLink: String,
        val phone: String,
        val rejectedItem: String,
        val rejectedNone: String,
        val bullet: String,
        val noUnknowns: String,
        val rejectedHeader: String,
        val remainingUnknowns: String,
        val phoneQuestionsHeader: String,
        val verificationUrl: String,
    ) {
        companion object {
            /** `getString` には Resources::getString（UI）や strings.xml 読み出し（JVM テスト）を渡す。 */
            fun from(getString: (Int) -> String): Labels = Labels(
                unknown = getString(R.string.decision_unknown),
                unknownSource = getString(R.string.decision_unknown_source),
                reasonWithSource = getString(R.string.decision_reason_with_source),
                reasonNone = getString(R.string.decision_reason_none),
                reasonExtraNone = getString(R.string.decision_reason_extra_none),
                phoneQuestion = getString(R.string.decision_phone_question),
                rejectedReason = getString(R.string.decision_rejected_reason),
                rejectedReasonUnknown = getString(R.string.decision_rejected_reason_unknown),
                selectedReason = getString(R.string.decision_selected_reason),
                storeName = getString(R.string.decision_store_name),
                dateTimeAddress = getString(R.string.decision_datetime_address),
                mapLink = getString(R.string.decision_map_link),
                phone = getString(R.string.decision_phone),
                rejectedItem = getString(R.string.decision_rejected_item),
                rejectedNone = getString(R.string.decision_rejected_none),
                bullet = getString(R.string.decision_bullet),
                noUnknowns = getString(R.string.decision_no_unknowns),
                rejectedHeader = getString(R.string.decision_rejected_header),
                remainingUnknowns = getString(R.string.decision_remaining_unknowns),
                phoneQuestionsHeader = getString(R.string.decision_phone_questions_header),
                verificationUrl = getString(R.string.decision_verification_url),
            )
        }
    }

    private fun String.fill(vararg args: Any): String = String.format(Locale.ROOT, this, *args)

    /** decisionText.ts L35-38 */
    private fun nonEmpty(value: String?): String? {
        val trimmed = value?.trim()
        return if (trimmed.isNullOrEmpty()) null else trimmed
    }

    /** decisionText.ts L40-42 */
    private fun valueOrUnknown(value: String?, labels: Labels): String = nonEmpty(value) ?: labels.unknown

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
    private fun sourceDomain(sourceUrl: String?, labels: Labels): String {
        val url = httpUrlOrUndefined(sourceUrl) ?: return labels.unknownSource
        return try {
            val host = URI(url).host ?: return labels.unknownSource
            host.replace(Regex("^www\\.", RegexOption.IGNORE_CASE), "").ifEmpty { labels.unknownSource }
        } catch (_: Exception) {
            labels.unknownSource
        }
    }

    /** decisionText.ts L67-71 */
    private fun evidenceForEvaluation(candidate: Candidate, evidenceIds: List<String>): Evidence? =
        evidenceIds.firstNotNullOfOrNull { id -> candidate.evidence.firstOrNull { it.id == id } }

    /** decisionText.ts L73-84 */
    private fun evaluationReason(candidate: Candidate, states: List<MatchState>, labels: Labels): String? {
        val evaluation = candidate.evaluations.firstOrNull { entry ->
            states.contains(entry.state) && nonEmpty(entry.explanation) != null
        } ?: return null
        val explanation = nonEmpty(evaluation.explanation) ?: return null
        val evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds)
        return labels.reasonWithSource.fill(explanation, sourceDomain(evidence?.sourceUrl, labels))
    }

    /** decisionText.ts L86-96 */
    private fun evidenceBackedReasons(candidate: Candidate, labels: Labels): List<String> =
        candidate.evaluations.flatMap { evaluation ->
            if (evaluation.state != MatchState.Match && evaluation.state != MatchState.Partial) {
                return@flatMap emptyList<String>()
            }
            val explanation = nonEmpty(evaluation.explanation)
            val evidence = evidenceForEvaluation(candidate, evaluation.evidenceIds)
            if (explanation == null || evidence == null) {
                emptyList()
            } else {
                listOf(labels.reasonWithSource.fill(explanation, sourceDomain(evidence.sourceUrl, labels)))
            }
        }

    /** decisionText.ts L98-116（3 行固定。優先順: reasons > reason > 生成） */
    private fun reasonLines(candidate: Candidate, options: Options, labels: Labels): List<String> {
        val suppliedReasons = (options.reasons ?: emptyList())
            .mapNotNull { nonEmpty(it) }
            .map { labels.reasonWithSource.fill(it, labels.unknownSource) }
        val generatedReasons = evidenceBackedReasons(candidate, labels)
        val oneLineReason = nonEmpty(options.reason)
        val reasons = when {
            suppliedReasons.isNotEmpty() -> suppliedReasons
            oneLineReason != null -> listOf(labels.reasonWithSource.fill(oneLineReason, labels.unknownSource))
            else -> generatedReasons
        }
        val safeReasons = reasons.ifEmpty { listOf(labels.reasonNone) }
        return (0 until 3).map { index ->
            safeReasons.getOrNull(index) ?: labels.reasonExtraNone
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
    private fun phoneQuestions(unknowns: List<Requirement>, options: Options, labels: Labels): List<String> {
        val suppliedQuestions = (options.phoneQuestions ?: emptyList())
            .mapNotNull { nonEmpty(it) }
            .take(MAX_PHONE_QUESTIONS)
        if (suppliedQuestions.isNotEmpty()) return suppliedQuestions
        return unknowns
            .mapNotNull { nonEmpty(it.text) }
            .map { labels.phoneQuestion.fill(it) }
            .take(MAX_PHONE_QUESTIONS)
    }

    /** decisionText.ts L146-149 */
    private fun rejectedReason(candidate: Candidate, labels: Labels): String {
        val reason = evaluationReason(
            candidate,
            listOf(MatchState.Mismatch, MatchState.Partial, MatchState.Unknown),
            labels,
        )
        return if (reason != null) labels.rejectedReason.fill(reason) else labels.rejectedReasonUnknown
    }

    /** decisionText.ts L155-209 */
    fun generateDecisionText(
        investigation: Investigation,
        selectedCandidate: Candidate,
        labels: Labels,
        options: Options = Options(),
    ): Result {
        val address = valueOrUnknown(selectedCandidate.place.address, labels)
        val dateTime = valueOrUnknown(options.dateTime, labels)
        val phoneNumber = valueOrUnknown(options.phoneNumber, labels)
        val mapUrl = httpUrlOrUndefined(options.mapUrl) ?: labels.unknown
        val verificationUrl = httpUrlOrUndefined(options.verificationUrl)
            ?: httpUrlOrUndefined(selectedCandidate.place.urls?.pc)
            ?: labels.unknown
        val reasons = reasonLines(selectedCandidate, options, labels)
        val shortReason = labels.selectedReason.fill(reasons[0])
        val unknowns = unknownRequirements(investigation, selectedCandidate)
        val questions = phoneQuestions(unknowns, options, labels)
        val storeName = labels.storeName.fill(valueOrUnknown(selectedCandidate.place.name, labels))
        val dateTimeAddress = labels.dateTimeAddress.fill(dateTime, address)
        val mapLink = labels.mapLink.fill(mapUrl)
        val phone = labels.phone.fill(phoneNumber)
        val rejected = investigation.candidates
            .filter { it.id != selectedCandidate.id }
            .sortedBy { it.rank }
            .take(MAX_REJECTED_CANDIDATES)

        val short = listOf(
            storeName,
            dateTimeAddress,
            mapLink,
            shortReason,
            phone,
        ).joinToString("\n")

        val rejectedLines = if (rejected.isNotEmpty()) {
            rejected.map { labels.rejectedItem.fill(valueOrUnknown(it.place.name, labels), rejectedReason(it, labels)) }
        } else {
            listOf(labels.rejectedNone)
        }
        val questionLines = if (questions.isNotEmpty()) {
            questions.map { labels.bullet.fill(it) }
        } else {
            listOf(labels.noUnknowns)
        }

        val detailed = (
            listOf(
                storeName,
                dateTimeAddress,
                mapLink,
                labels.selectedReason.fill(reasons[0]),
                labels.selectedReason.fill(reasons[1]),
                labels.selectedReason.fill(reasons[2]),
                labels.rejectedHeader,
            ) + rejectedLines + listOf(
                labels.remainingUnknowns.fill(unknowns.size),
                labels.phoneQuestionsHeader,
            ) + questionLines + listOf(
                phone,
                labels.verificationUrl.fill(verificationUrl),
            )
            ).joinToString("\n")

        return Result(short, detailed)
    }
}
