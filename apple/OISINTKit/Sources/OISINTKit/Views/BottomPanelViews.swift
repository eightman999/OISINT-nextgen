import SwiftUI

// src/components/BottomPanels.tsx の移植（design.html .bottom-grid の3パネル: 比較 / みんなの投票 / Evidence）

/// パネル共通スタイル
private struct PanelChrome: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DesignTokens.Colors.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(DesignTokens.Colors.border.color, lineWidth: 1))
    }
}

private func panelTitle(_ title: String) -> some View {
    Text(title)
        .oisintFont(13, .bold)
        .foregroundStyle(DesignTokens.Colors.text.color)
        .padding(.bottom, 10)
}

/// 比較パネル: ○△×? マトリクス
public struct ComparisonPanelView: View {
    let candidates: [Candidate]
    let requirements: [Requirement]

    public init(candidates: [Candidate], requirements: [Requirement]) {
        self.candidates = candidates
        self.requirements = requirements
    }

    public var body: some View {
        // BottomPanels.tsx の flex 比率（tableLabelCell flex:1.4 / 他セル flex:1）を再現する。
        // 旧実装の layoutPriority(1.4) は比率ではなく優先度のため、compact 幅で
        // ラベル列が全幅を奪い候補列（店名・○△×?）が 0 幅に潰れていた（#241 同種の見切れ）
        let ratios = [CGFloat(1.4)] + Array(repeating: CGFloat(1), count: candidates.count)
        VStack(alignment: .leading, spacing: 0) {
            panelTitle("比較")
            FlexRow(ratios: ratios, spacing: 4) {
                Text("").oisintFont(9, .bold)
                    .frame(maxWidth: .infinity)
                ForEach(candidates) { candidate in
                    Text(candidate.place.name)
                        .oisintFont(9, .bold)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("comparison-head-\(candidate.id)")
                }
            }
            .padding(.vertical, 6)
            .overlay(alignment: .bottom) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
            ForEach(requirements) { requirement in
                FlexRow(ratios: ratios, spacing: 4) {
                    Text(requirement.text)
                        .oisintFont(9)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(candidates) { candidate in
                        let state = candidate.evaluations.first { $0.requirementId == requirement.id }?.state ?? .unknown
                        Text(Format.matchStateSymbol(state))
                            .oisintFont(11, .heavy)
                            .foregroundStyle(Format.matchStateColor(state).color)
                            .frame(maxWidth: .infinity)
                            .accessibilityLabel(Format.matchStateAccessibilityLabel(state))
                    }
                }
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) { DesignTokens.Colors.borderSoft.color.frame(height: 1) }
            }
        }
        .modifier(PanelChrome())
    }
}

/// RN の flex 比率分配を再現する行レイアウト（比較テーブル用。#241）。
/// 各子へ「(親幅 - spacing 合計) × ratio / ratio 合計」の幅を提案して等比で並べる。
struct FlexRow: Layout {
    var ratios: [CGFloat]
    var spacing: CGFloat = 4

    private func columnWidths(totalWidth: CGFloat, count: Int) -> [CGFloat] {
        let available = max(totalWidth - spacing * CGFloat(max(count - 1, 0)), 0)
        let ratioSum = ratios.prefix(count).reduce(0, +)
        guard ratioSum > 0 else { return Array(repeating: 0, count: count) }
        return (0..<count).map { available * (ratios.indices.contains($0) ? ratios[$0] : 1) / ratioSum }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        let widths = columnWidths(totalWidth: width, count: subviews.count)
        let height = zip(subviews, widths)
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widths = columnWidths(totalWidth: bounds.width, count: subviews.count)
        var x = bounds.minX
        for (subview, width) in zip(subviews, widths) {
            let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            subview.place(
                at: CGPoint(x: x, y: bounds.midY - size.height / 2),
                proposal: ProposedViewSize(width: width, height: nil)
            )
            x += width + spacing
        }
    }
}

/// みんなの投票パネル: rank + 店名 + 👍数
public struct VotePanelView: View {
    let candidates: [Candidate]
    let onVotePress: (() -> Void)?
    @State private var voteHovering = false

    public init(candidates: [Candidate], onVotePress: (() -> Void)? = nil) {
        self.candidates = candidates
        self.onVotePress = onVotePress
    }

    public var body: some View {
        let sorted = candidates.sorted { $0.rank < $1.rank }
        VStack(alignment: .leading, spacing: 0) {
            panelTitle("みんなの投票")
            VStack(spacing: 7) {
                ForEach(sorted) { candidate in
                    let upVotes = candidate.votes.values.filter { $0 == .up }.count
                    HStack(spacing: 7) {
                        Text("\(candidate.rank)")
                            .oisintFont(12, .heavy)
                            .monospacedDigit()
                            .foregroundStyle(DesignTokens.Colors.text.color)
                            .frame(width: 20, alignment: .leading)
                        Text(candidate.place.name)
                            .oisintFont(10, .bold)
                            .foregroundStyle(DesignTokens.Colors.text.color)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(upVotes)票")
                            .oisintFont(10)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 36)
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
                }
            }
            if let onVotePress {
                Button(action: onVotePress) {
                    Text("投票する")
                        .oisintFont(12, .bold)
                        .foregroundStyle(DesignTokens.Colors.surface.color)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        // hover 時は orangeHover（Web の :hover。§3.6-5）
                        .background((voteHovering ? DesignTokens.Colors.orangeHover : DesignTokens.Colors.orange).color)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
                .onHover { voteHovering = $0 }
                .accessibilityLabel("候補に投票する")
                .padding(.top, 10)
            }
        }
        .modifier(PanelChrome())
    }
}

/// Evidence パネル: sourceIcon + excerpt + observedAt（先頭 4 件）
public struct EvidencePanelView: View {
    let evidence: [Evidence]

    public init(evidence: [Evidence]) {
        self.evidence = evidence
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            panelTitle("Evidence")
            if evidence.isEmpty {
                Text("Evidenceはまだ収集されていません")
                    .oisintFont(11)
                    .italic()
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            } else {
                VStack(spacing: 6) {
                    ForEach(evidence.prefix(4)) { item in
                        HStack(spacing: 7) {
                            RoundedRectangle(cornerRadius: 5)
                                .fill(ColorToken("#f1f1f1").color)
                                .frame(width: 22, height: 22)
                                .overlay(
                                    Text(String((item.sourceTitle ?? item.sourceType).prefix(1)))
                                        .oisintFont(10, .bold)
                                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                                )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.sourceTitle ?? item.sourceType)
                                    .oisintFont(10, .bold)
                                    .foregroundStyle(DesignTokens.Colors.text.color)
                                    .lineLimit(1)
                                Text(item.excerpt)
                                    .oisintFont(8)
                                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            // BottomPanels.tsx: observedAt.slice(5).replace('-', '/')
                            Text(String(item.observedAt.dropFirst(5)).replacingOccurrences(of: "-", with: "/"))
                                .oisintFont(9)
                                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                        }
                        .padding(7)
                        .frame(minHeight: 38)
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
                    }
                }
            }
        }
        .modifier(PanelChrome())
    }
}
