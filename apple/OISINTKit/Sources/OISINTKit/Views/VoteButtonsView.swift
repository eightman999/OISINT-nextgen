import SwiftUI

/// src/components/VoteButtons.tsx の移植
/// 👍 行きたい / 🤔 どちらでも / 👎 行きたくない の 3 値トグル。選択中は orange 塗り（spec.md §21）
public struct VoteButtonsView: View {
    let value: VoteValue
    let onChange: ((VoteValue) -> Void)?

    public init(value: VoteValue, onChange: ((VoteValue) -> Void)? = nil) {
        self.value = value
        self.onChange = onChange
    }

    private static let options: [(value: VoteValue, label: String)] = [
        (.up, String(localized: "行きたい", bundle: .module)),
        (.neutral, String(localized: "どちらでも", bundle: .module)),
        (.down, String(localized: "行きたくない", bundle: .module)),
    ]

    public var body: some View {
        HStack(spacing: 8) {
            ForEach(Self.options, id: \.value) { option in
                let active = value == option.value
                Button {
                    onChange?(option.value)
                } label: {
                    VStack(spacing: 4) {
                        Text(Format.voteSymbol(option.value))
                            .oisintFont(20)
                        Text(option.label)
                            .oisintFont(12, .semibold)
                            .foregroundStyle(
                                active
                                    ? DesignTokens.Colors.surface.color
                                    : DesignTokens.Colors.textSecondary.color
                            )
                    }
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(active ? DesignTokens.Colors.orange.color : DesignTokens.Colors.chipBg.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                            .stroke(
                                active ? DesignTokens.Colors.orange.color : DesignTokens.Colors.borderSoft.color,
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
        }
    }
}
