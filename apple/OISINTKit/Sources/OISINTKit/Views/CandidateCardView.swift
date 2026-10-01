import SwiftUI

/// src/components/CandidateCard.tsx の移植。
/// rankBadge（rankColor・27px・右下のみ角丸 8）、genreColor ヒーロー、条件一致サマリ、
/// TAG_STYLES タグ、投票バッジを踏襲。
public struct CandidateCardView: View {
    let candidate: Candidate
    let members: [InvestigationMember]
    let requirements: [Requirement]
    let isSelected: Bool
    let onPress: (() -> Void)?

    public init(
        candidate: Candidate,
        members: [InvestigationMember],
        requirements: [Requirement] = [],
        isSelected: Bool = false,
        onPress: (() -> Void)? = nil
    ) {
        self.candidate = candidate
        self.members = members
        self.requirements = requirements
        self.isSelected = isSelected
        self.onPress = onPress
    }

    struct CardTag: Identifiable {
        var id: String { label }
        let label: String
        let style: TagStyle
    }

    /// CandidateCard.tsx buildTags の移植
    static func buildTags(_ candidate: Candidate) -> [CardTag] {
        var tags: [CardTag] = []
        let place = candidate.place
        if let access = place.access,
           let range = access.range(of: "徒歩\\d+分", options: .regularExpression) {
            tags.append(CardTag(label: String(access[range]), style: DesignTokens.Components.tagBlue))
        }
        if let budget = place.budget {
            tags.append(CardTag(label: "予算 \(budget)", style: DesignTokens.Components.tagGreen))
        }
        if place.card == "可" {
            tags.append(CardTag(label: "カード可", style: DesignTokens.Components.tagOrange))
        }
        if !candidate.contradictions.isEmpty {
            tags.append(CardTag(label: "⚠ 矛盾\(candidate.contradictions.count)件", style: DesignTokens.Components.tagRed))
        }
        return tags
    }

    private var unresolvedMustRequirements: [Requirement] {
        requirements
            .filter { $0.priority == .must }
            .filter { requirement in
                guard let evaluation = candidate.evaluations.first(where: { $0.requirementId == requirement.id }) else {
                    return true
                }
                return evaluation.state == .unknown
            }
    }

    private var mismatchedMustRequirements: [Requirement] {
        requirements
            .filter { $0.priority == .must }
            .filter { requirement in
                candidate.evaluations.contains {
                    $0.requirementId == requirement.id && $0.state == .mismatch
                }
            }
    }

    private var suppressRecommendationEmphasis: Bool {
        candidate.rank == 1 && !unresolvedMustRequirements.isEmpty
    }

    private var cardAccessibilityLabel: String {
        var label = "候補\(candidate.rank)位 \(candidate.place.name)"
        if suppressRecommendationEmphasis {
            label += "。必須条件に未確認項目があるためおすすめ未確定です"
        }
        return label + "。候補の詳細を表示"
    }

    public var body: some View {
        Button {
            onPress?()
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                hero
                body_
            }
            .background(DesignTokens.Colors.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                    .stroke(
                        isSelected ? DesignTokens.Colors.orange.color : DesignTokens.Colors.border.color,
                        lineWidth: isSelected ? 2 : 1
                    )
            )
            // design.html .restaurant-card: 0 2px 7px rgba(30,26,22,0.04)
            .shadow(
                color: Color(.sRGB, red: 30 / 255, green: 26 / 255, blue: 22 / 255)
                    .opacity(DesignTokens.Components.cardShadowOpacity),
                radius: DesignTokens.Components.cardShadowRadius,
                y: DesignTokens.Components.cardShadowY
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(cardAccessibilityLabel)
        .accessibilityHint("タップすると条件適合度と根拠を確認できます")
        .accessibilityIdentifier("inv-candidate-\(candidate.rank)")
    }

    private var hero: some View {
        let genreColor = DesignTokens.genreColor(candidate.place.genre)
        let rankColor = DesignTokens.rankColor(candidate.rank)

        return ZStack(alignment: .topLeading) {
            genreColor.color
                .aspectRatio(1.8, contentMode: .fill)
                .overlay(alignment: .bottomLeading) {
                    Text(candidate.place.genre ?? "グルメ")
                        .oisintFont(11, .bold)
                        .foregroundStyle(DesignTokens.readableTextColor(for: genreColor).color)
                        .padding(8)
                }

            if suppressRecommendationEmphasis {
                Text("調査不足")
                    .oisintFont(10, .heavy)
                    .foregroundStyle(DesignTokens.Colors.warning.color)
                    .padding(.horizontal, 9)
                    .frame(minHeight: 27)
                    .background(DesignTokens.Colors.warningSoft.color)
                    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 8))
                    .accessibilityLabel("1位候補ですが、必須条件が未確認のためおすすめ未確定です")
                    .accessibilityIdentifier("inv-rank-unverified-\(candidate.rank)")
            } else {
                // rankBadge: 27x27・rankColor・borderBottomRightRadius 8（左上直角）
                UnevenRoundedRectangle(bottomTrailingRadius: 8)
                    .fill(rankColor.color)
                    .frame(width: 27, height: 27)
                    .overlay(
                        Text("\(candidate.rank)")
                            .oisintFont(13, .heavy)
                            .monospacedDigit()
                            .foregroundStyle(DesignTokens.readableTextColor(for: rankColor).color)
                    )
                    .accessibilityIdentifier("inv-rank-\(candidate.rank)")
            }
        }
        .clipped()
    }

    private var body_: some View {
        let tags = Self.buildTags(candidate)
        let totalRequirements = requirements.isEmpty ? candidate.evaluations.count : requirements.count
        let matchedRequirements = candidate.evaluations.filter { $0.state == .match }.count
        let missingMust = requirements
            .filter { $0.priority == .must }
            .filter { requirement in
                guard let evaluation = candidate.evaluations.first(where: { $0.requirementId == requirement.id }) else { return true }
                return evaluation.state == .mismatch || evaluation.state == .unknown
            }
        let voteDisplay: [(name: String, value: VoteValue)] = candidate.votes
            .sorted { $0.key < $1.key }
            .filter { $0.value != .neutral }
            .map { userId, value in
                (members.first { $0.id == userId }?.displayName ?? "不明", value)
            }

        return VStack(alignment: .leading, spacing: 8) {
            Text(candidate.place.name)
                .oisintFont(14, .bold)
                .foregroundStyle(DesignTokens.Colors.text.color)

            Text("\(candidate.place.genre ?? "")\n\(candidate.place.access ?? "")")
                .oisintFont(10)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)

            Text("条件 \(matchedRequirements)/\(totalRequirements)件が一致")
                .oisintFont(10, .bold)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                .accessibilityLabel("条件 \(matchedRequirements)/\(totalRequirements)件が一致")
                .accessibilityIdentifier("inv-fill-\(candidate.rank)")

            if suppressRecommendationEmphasis {
                Text("未確認の必須条件あり: \(unresolvedMustRequirements.map(\.normalizedText).joined(separator: "、"))")
                    .oisintFont(10, .bold)
                    .foregroundStyle(DesignTokens.Colors.warning.color)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesignTokens.Colors.warningSoft.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                    .accessibilityIdentifier("inv-gap-\(candidate.rank)")

                if !mismatchedMustRequirements.isEmpty {
                    Text("不適合の必須条件: \(mismatchedMustRequirements.map(\.normalizedText).joined(separator: "、"))")
                        .oisintFont(10, .bold)
                        .foregroundStyle(DesignTokens.Colors.warning.color)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(DesignTokens.Colors.warningSoft.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                        .accessibilityIdentifier("inv-mismatch-\(candidate.rank)")
                }
            } else if !missingMust.isEmpty {
                Text("要確認: \(missingMust.map(\.normalizedText).joined(separator: "、"))")
                    .oisintFont(10)
                    .foregroundStyle(DesignTokens.Colors.warning.color)
                    .accessibilityIdentifier("inv-gap-\(candidate.rank)")
            }

            if !tags.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(tags) { tag in
                        Text(tag.label)
                            .oisintFont(9, .bold)
                            .foregroundStyle(tag.style.color.color)
                            .padding(.horizontal, 7)
                            .frame(minHeight: 18)
                            .background(tag.style.background.color)
                            .clipShape(Capsule())
                    }
                }
            }

            if candidate.place.open != nil || candidate.place.close != nil {
                Text("営業 \(candidate.place.open ?? "?")〜\(candidate.place.close ?? "?")")
                    .oisintFont(10)
                    .foregroundStyle(ColorToken("#555d63").color)
            }

            if !candidate.evaluations.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(candidate.evaluations, id: \.requirementId) { evaluation in
                        HStack(spacing: 8) {
                            Text(requirements.first { $0.id == evaluation.requirementId }?.normalizedText ?? evaluation.requirementId)
                                .oisintFont(10)
                                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Text(Format.matchStateSymbol(evaluation.state))
                                .oisintFont(12, .heavy)
                                .foregroundStyle(Format.matchStateColor(evaluation.state).color)
                                .accessibilityLabel(Format.matchStateAccessibilityLabel(evaluation.state))
                        }
                    }
                }
                .padding(.top, 8)
                .overlay(alignment: .top) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
            }

            if let budget = candidate.place.budget {
                Text("予算目安　\(budget) / 人")
                    .oisintFont(10)
                    .foregroundStyle(ColorToken("#4e555b").color)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
            }

            if !voteDisplay.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(Array(voteDisplay.enumerated()), id: \.offset) { _, vote in
                        Text("\(vote.name): \(vote.value == .up ? "👍" : "👎")")
                            .oisintFont(10)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                            .padding(.vertical, 2)
                            .padding(.horizontal, 8)
                            .background(DesignTokens.Colors.surfaceSoft.color)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(12)
    }
}
