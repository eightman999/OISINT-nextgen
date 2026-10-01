import SwiftUI

/// src/components/CandidateDetail.tsx の移植。
/// セクション: 条件 / Evidence / ⚠ 矛盾（warningSoft 背景）/ 投票 / この店に決めた（クリップボード）。
public struct CandidateDetailView: View {
    let candidate: Candidate
    let investigation: Investigation?
    let requirements: [Requirement]
    let userVote: VoteValue
    let onVoteChange: ((VoteValue) -> Void)?
    let openURL: (URL) -> Void
    let copyText: (String) -> Bool

    @State private var decisionFormat: DecisionFormat?
    @State private var copyStatus: CopyStatus = .idle

    enum DecisionFormat {
        case short, detailed
    }

    enum CopyStatus {
        case idle, copied, unavailable
    }

    public init(
        candidate: Candidate,
        investigation: Investigation?,
        requirements: [Requirement],
        userVote: VoteValue = .neutral,
        onVoteChange: ((VoteValue) -> Void)? = nil,
        openURL: @escaping (URL) -> Void,
        copyText: @escaping (String) -> Bool
    ) {
        self.candidate = candidate
        self.investigation = investigation
        self.requirements = requirements
        self.userVote = userVote
        self.onVoteChange = onVoteChange
        self.openURL = openURL
        self.copyText = copyText
    }

    private var decisionText: DecisionText.Result? {
        guard let investigation else { return nil }
        return DecisionText.generate(
            investigation: investigation,
            selectedCandidate: candidate,
            options: DecisionText.Options(mapUrl: DecisionText.mapUrl(for: candidate))
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(candidate.place.name)
                .oisintFont(22, .bold)
                .foregroundStyle(DesignTokens.Colors.text.color)

            evaluationSection
            evidenceSection
            if !candidate.contradictions.isEmpty {
                contradictionSection
            }
            voteSection
            if let decisionText {
                decisionSection(decisionText)
            }
        }
        .padding(.top, 8)
    }

    // MARK: - 条件

    private var evaluationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeading("条件")
            ForEach(candidate.evaluations, id: \.requirementId) { evaluation in
                let requirement = requirements.first { $0.id == evaluation.requirementId }
                let evidence = evaluation.evidenceIds
                    .compactMap { id in candidate.evidence.first { $0.id == id } }
                    .first
                HStack(alignment: .center, spacing: 12) {
                    Text(Format.matchStateSymbol(evaluation.state))
                        .oisintFont(18, .heavy)
                        .foregroundStyle(Format.matchStateColor(evaluation.state).color)
                        .frame(width: 24)
                        .accessibilityLabel(Format.matchStateAccessibilityLabel(evaluation.state))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(requirement?.normalizedText ?? evaluation.requirementId)
                            .oisintFont(14)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        Text(evaluation.explanation)
                            .oisintFont(12)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        Text(DecisionText.sourceLabel(evidence))
                            .oisintFont(11)
                            .foregroundStyle(DesignTokens.Colors.info.color)
                    }
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
            }
        }
    }

    // MARK: - Evidence

    private var evidenceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeading("Evidence")
            if candidate.evidence.isEmpty {
                Text("Evidenceはまだ収集されていません")
                    .oisintFont(13)
                    .italic()
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            } else {
                ForEach(candidate.evidence) { evidence in
                    Button {
                        if let url = URL(string: evidence.sourceUrl) {
                            openURL(url)
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(evidence.sourceTitle ?? evidence.sourceType)
                                .oisintFont(14, .bold)
                                .foregroundStyle(DesignTokens.Colors.text.color)
                            Text(evidence.excerpt)
                                .oisintFont(13)
                                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                            Text(evidence.sourceUrl)
                                .oisintFont(11)
                                .foregroundStyle(DesignTokens.Colors.info.color)
                                .accessibilityIdentifier("evidence-source-url")
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(DesignTokens.Colors.surface.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                                .stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(evidence.sourceTitle ?? evidence.sourceType)。Evidenceを開く")
                }
            }
            Text("引用は原文照合していません。重要な条件は出典を開いて店舗へ直接確認してください。")
                .oisintFont(10)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                .accessibilityIdentifier("inv-evidence-footnote")
        }
    }

    // MARK: - 矛盾（warningSoft 背景 + warning 枠）

    private var contradictionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeading("⚠ 矛盾")
            ForEach(Array(candidate.contradictions.enumerated()), id: \.offset) { _, contradiction in
                VStack(alignment: .leading, spacing: 4) {
                    Text(contradiction.key)
                        .oisintFont(14, .bold)
                        .foregroundStyle(DesignTokens.Colors.warning.color)
                    ForEach(contradiction.entries, id: \.evidenceId) { entry in
                        Text("\(entry.evidenceId): \(displayValue(entry.value))")
                            .oisintFont(13)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Colors.warningSoft.color)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                        .stroke(DesignTokens.Colors.warning.color, lineWidth: 1)
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inv-contradiction")
    }

    private func displayValue(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .number(let n): return n.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .null: return "null"
        case .array, .object:
            if let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) {
                return text
            }
            return "?"
        }
    }

    // MARK: - 投票

    private var voteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeading("投票")
            VoteButtonsView(value: userVote, onChange: onVoteChange)
        }
    }

    // MARK: - この店に決めた

    private func decisionSection(_ text: DecisionText.Result) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeading("この店に決めた")
            Button {
                if decisionFormat == nil {
                    decisionFormat = .short
                }
                copyStatus = .idle
            } label: {
                Text("貼り付け用テキストを作る")
                    .oisintFont(13, .bold)
                    .foregroundStyle(DesignTokens.Colors.surface.color)
                    .frame(maxWidth: .infinity, minHeight: 42)
                    .background(DesignTokens.Colors.orange.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("この店に決めた。決定テキストの形式を選ぶ")
            .accessibilityIdentifier("decision-button")

            if let format = decisionFormat {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        formatButton("短い版", format: .short, current: format, identifier: "decision-short")
                        formatButton("詳しい版", format: .detailed, current: format, identifier: "decision-detailed")
                    }
                    Text(format == .short ? text.short : text.detailed)
                        .oisintFont(12)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading)
                        .background(DesignTokens.Colors.surfaceSoft.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs))
                    Button {
                        copyStatus = copyText(format == .short ? text.short : text.detailed) ? .copied : .unavailable
                    } label: {
                        Text("コピー")
                            .oisintFont(12, .bold)
                            .foregroundStyle(DesignTokens.Colors.text.color)
                            .frame(maxWidth: .infinity, minHeight: 38)
                            .overlay(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                                    .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(format == .short ? "短い版" : "詳しい版")をコピー")
                    .accessibilityIdentifier("decision-copy")
                    if copyStatus == .copied {
                        copyStatusText("コピーしました")
                    }
                    if copyStatus == .unavailable {
                        copyStatusText("この環境ではコピーできません。テキストを長押しして選択してください。")
                    }
                }
            }
        }
        .padding(.top, 4)
        .overlay(alignment: .top) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("decision-text")
    }

    private func formatButton(_ title: String, format: DecisionFormat, current: DecisionFormat, identifier: String) -> some View {
        let active = format == current
        return Button {
            decisionFormat = format
            copyStatus = .idle
        } label: {
            Text(title)
                .oisintFont(12, .semibold)
                .foregroundStyle(DesignTokens.Colors.text.color)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(active ? DesignTokens.Colors.activeBg.color : DesignTokens.Colors.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                        .stroke(
                            active ? DesignTokens.Colors.orange.color : DesignTokens.Colors.border.color,
                            lineWidth: 1
                        )
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)を選ぶ")
        .accessibilityAddTraits(active ? [.isSelected] : [])
        .accessibilityIdentifier(identifier)
    }

    private func copyStatusText(_ message: String) -> some View {
        Text(message)
            .oisintFont(11)
            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .oisintFont(15, .bold)
            .foregroundStyle(DesignTokens.Colors.text.color)
            .padding(.bottom, 4)
    }
}
