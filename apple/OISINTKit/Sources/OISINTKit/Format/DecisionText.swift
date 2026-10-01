import Foundation

/// src/lib/decisionText.ts の逐語移植。「この店に決めた」の貼り付け用テキスト生成。
/// Evidence の無い断定を出さず、不明は「不明」と明示する（spec.md §30 / 計画書 §36-6）。
public enum DecisionText {
    public struct Options: Sendable {
        public var dateTime: String?
        public var phoneNumber: String?
        public var mapUrl: String?
        public var reason: String?
        public var reasons: [String]
        public var phoneQuestions: [String]
        public var verificationUrl: String?

        public init(dateTime: String? = nil, phoneNumber: String? = nil, mapUrl: String? = nil, reason: String? = nil, reasons: [String] = [], phoneQuestions: [String] = [], verificationUrl: String? = nil) {
            self.dateTime = dateTime
            self.phoneNumber = phoneNumber
            self.mapUrl = mapUrl
            self.reason = reason
            self.reasons = reasons
            self.phoneQuestions = phoneQuestions
            self.verificationUrl = verificationUrl
        }
    }

    public struct Result: Sendable, Equatable {
        public var short: String
        public var detailed: String
    }

    static let unknown = "不明"
    static let unknownSource = "出典不明"
    static let maxRejectedCandidates = 2
    static let maxPhoneQuestions = 3

    static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    static func valueOrUnknown(_ value: String?) -> String {
        nonEmpty(value) ?? unknown
    }

    static func httpUrlOrNil(_ value: String?) -> String? {
        guard let candidate = nonEmpty(value), let url = URL(string: candidate),
              url.scheme == "http" || url.scheme == "https" else { return nil }
        return candidate
    }

    static func sourceDomain(_ sourceUrl: String?) -> String {
        guard let urlString = httpUrlOrNil(sourceUrl), let host = URL(string: urlString)?.host else {
            return unknownSource
        }
        let domain = host.replacingOccurrences(of: "^www\\.", with: "", options: [.regularExpression, .caseInsensitive])
        return domain.isEmpty ? unknownSource : domain
    }

    static func evidenceForEvaluation(_ candidate: Candidate, evidenceIds: [String]) -> Evidence? {
        evidenceIds.compactMap { id in candidate.evidence.first { $0.id == id } }.first
    }

    static func evaluationReason(_ candidate: Candidate, states: [MatchState]) -> String? {
        guard let evaluation = candidate.evaluations.first(where: { states.contains($0.state) && nonEmpty($0.explanation) != nil }),
              let explanation = nonEmpty(evaluation.explanation) else { return nil }
        let evidence = evidenceForEvaluation(candidate, evidenceIds: evaluation.evidenceIds)
        return "\(explanation)（\(sourceDomain(evidence?.sourceUrl))）"
    }

    static func evidenceBackedReasons(_ candidate: Candidate) -> [String] {
        candidate.evaluations.compactMap { evaluation in
            guard [MatchState.match, .partial].contains(evaluation.state),
                  let explanation = nonEmpty(evaluation.explanation),
                  let evidence = evidenceForEvaluation(candidate, evidenceIds: evaluation.evidenceIds)
            else { return nil }
            return "\(explanation)（\(sourceDomain(evidence.sourceUrl))）"
        }
    }

    static func reasonLines(_ candidate: Candidate, options: Options) -> [String] {
        let suppliedReasons = options.reasons.compactMap(nonEmpty).map { "\($0)（\(unknownSource)）" }
        let generatedReasons = evidenceBackedReasons(candidate)
        let oneLineReason = nonEmpty(options.reason)
        let reasons: [String]
        if !suppliedReasons.isEmpty {
            reasons = suppliedReasons
        } else if let oneLineReason {
            reasons = ["\(oneLineReason)（\(unknownSource)）"]
        } else {
            reasons = generatedReasons
        }
        let safeReasons = reasons.isEmpty ? ["根拠を確認できる情報は\(unknown)（\(unknownSource)）"] : reasons
        return (0..<3).map { index in
            index < safeReasons.count ? safeReasons[index] : "追加の選定理由は\(unknown)（\(unknownSource)）"
        }
    }

    static func unknownRequirements(_ investigation: Investigation, _ candidate: Candidate) -> [Requirement] {
        let evaluationsByRequirement = Dictionary(
            candidate.evaluations.map { ($0.requirementId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return investigation.requirements.filter { requirement in
            guard let evaluation = evaluationsByRequirement[requirement.id] else { return true }
            return evaluation.state == .unknown
        }
    }

    static func phoneQuestions(_ unknowns: [Requirement], options: Options) -> [String] {
        let supplied = options.phoneQuestions.compactMap(nonEmpty).prefix(maxPhoneQuestions)
        if !supplied.isEmpty { return Array(supplied) }
        return unknowns.compactMap { nonEmpty($0.text) }.map { "「\($0)」について確認する" }.prefix(maxPhoneQuestions).map { $0 }
    }

    static func rejectedReason(_ candidate: Candidate) -> String {
        if let reason = evaluationReason(candidate, states: [.mismatch, .partial, .unknown]) {
            return "判定理由: \(reason)"
        }
        return "判定理由は\(unknown)（\(unknownSource)）"
    }

    /// decisionText.ts generateDecisionText の移植
    public static func generate(
        investigation: Investigation,
        selectedCandidate: Candidate,
        options: Options = Options()
    ) -> Result {
        let address = valueOrUnknown(selectedCandidate.place.address)
        let dateTime = valueOrUnknown(options.dateTime)
        let phoneNumber = valueOrUnknown(options.phoneNumber)
        let mapUrl = httpUrlOrNil(options.mapUrl) ?? unknown
        let verificationUrl = httpUrlOrNil(options.verificationUrl)
            ?? httpUrlOrNil(selectedCandidate.place.urls?.pc)
            ?? unknown
        let reasons = reasonLines(selectedCandidate, options: options)
        let shortReason = "選んだ理由: \(reasons[0])"
        let unknowns = unknownRequirements(investigation, selectedCandidate)
        let questions = phoneQuestions(unknowns, options: options)
        let rejected = investigation.candidates
            .filter { $0.id != selectedCandidate.id }
            .sorted { $0.rank < $1.rank }
            .prefix(maxRejectedCandidates)

        let short = [
            "店名: \(valueOrUnknown(selectedCandidate.place.name))",
            "日時・住所: \(dateTime) / \(address)",
            "地図リンク: \(mapUrl)",
            shortReason,
            "電話番号: \(phoneNumber)",
        ].joined(separator: "\n")

        let rejectedLines = rejected.isEmpty
            ? ["・比較対象: \(unknown)（比較対象なし）"]
            : rejected.map { "・\(valueOrUnknown($0.place.name)): \(rejectedReason($0))" }
        let questionLines = questions.isEmpty
            ? ["・\(unknown)な条件はありません"]
            : questions.map { "・\($0)" }

        let detailed = ([
            "店名: \(valueOrUnknown(selectedCandidate.place.name))",
            "日時・住所: \(dateTime) / \(address)",
            "地図リンク: \(mapUrl)",
            "選んだ理由: \(reasons[0])",
            "選んだ理由: \(reasons[1])",
            "選んだ理由: \(reasons[2])",
            "落とした2件の理由:",
        ] + rejectedLines + [
            "残る不明: \(unknowns.count)件",
            "店に電話で聞くこと:",
        ] + questionLines + [
            "電話番号: \(phoneNumber)",
            "検証用URL: \(verificationUrl)",
        ]).joined(separator: "\n")

        return Result(short: short, detailed: detailed)
    }

    /// CandidateDetail.tsx mapUrlFor の移植
    public static func mapUrl(for candidate: Candidate) -> String {
        let query = candidate.place.address ?? candidate.place.name
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? query
        return "https://www.google.com/maps/search/?api=1&query=\(encoded)"
    }

    /// CandidateDetail.tsx sourceLabel の移植
    public static func sourceLabel(_ evidence: Evidence?) -> String {
        guard let evidence else { return String(localized: "出典不明", bundle: .module) }
        if let host = URL(string: evidence.sourceUrl)?.host {
            let domain = host.replacingOccurrences(of: "^www\\.", with: "", options: [.regularExpression, .caseInsensitive])
            return "\(evidence.sourceTitle ?? evidence.sourceType) · \(domain)"
        }
        return evidence.sourceTitle ?? evidence.sourceType
    }
}
