import SwiftUI

/// src/components/RequirementList.tsx の移植（見出し「条件」+ チップ + 追加ボタン）
public struct RequirementListView: View {
    let requirements: [Requirement]
    let onAddPress: (() -> Void)?

    public init(requirements: [Requirement], onAddPress: (() -> Void)? = nil) {
        self.requirements = requirements
        self.onAddPress = onAddPress
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("条件", bundle: .module)
                .oisintFont(16, .bold)
                .foregroundStyle(DesignTokens.Colors.text.color)
                .padding(.bottom, 2)
            FlowLayout(spacing: 7) {
                ForEach(requirements) { requirement in
                    Text(requirement.normalizedText)
                        .oisintFont(12, .semibold)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 28)
                        .background(DesignTokens.Colors.chipBg.color)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
                }
                if let onAddPress {
                    Button(action: onAddPress) {
                        Text("＋ 条件を追加", bundle: .module)
                            .oisintFont(12, .semibold)
                            .foregroundStyle(DesignTokens.Colors.orange.color)
                            .padding(.vertical, 5)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("条件を追加", bundle: .module))
                }
            }
        }
    }
}
