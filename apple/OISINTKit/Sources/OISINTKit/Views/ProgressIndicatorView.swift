import SwiftUI

/// src/components/ProgressIndicator.tsx の移植
/// statusOrder 順チップ、✓ / ● / ○ / ! 記号、アクティブは orange・bold
public struct ProgressIndicatorView: View {
    let status: InvestigationStatus

    public init(status: InvestigationStatus) {
        self.status = status
    }

    public var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(Format.statusOrder, id: \.self) { step in
                HStack(spacing: 4) {
                    Text(Format.statusSymbol(step, current: status))
                        .oisintFont(12)
                    Text(Format.statusLabel(step))
                        .oisintFont(12, step == status ? .bold : .regular)
                        .foregroundStyle(
                            step == status
                                ? DesignTokens.Colors.orange.color
                                : DesignTokens.Colors.textSecondary.color
                        )
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 10)
                .background(DesignTokens.Colors.chipBg.color)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("調査の進行状況: \(Format.statusLabel(status))")
        .accessibilityIdentifier("progress-steps")
    }
}

/// RN の flexWrap: 'wrap' 相当の折り返しレイアウト
public struct FlowLayout: Layout {
    var spacing: CGFloat

    public init(spacing: CGFloat = 8) {
        self.spacing = spacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        let width = proposal.width ?? rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [Row] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [Row] = []
        var current = Row()
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let nextWidth = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if nextWidth > maxWidth, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.indices.append(index)
            current.width = current.indices.count == 1 ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
        }
        if !current.indices.isEmpty {
            rows.append(current)
        }
        return rows
    }
}
