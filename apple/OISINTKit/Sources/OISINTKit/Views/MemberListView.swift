import SwiftUI

/// src/components/MemberList.tsx の移植（アバター重なり -8 / avatarColors / 「N人が参加中」）
public struct MemberListView: View {
    let members: [InvestigationMember]

    public init(members: [InvestigationMember]) {
        self.members = members
    }

    public var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 0) {
                ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                    avatar(member: member, index: index)
                        .padding(.leading, index > 0 ? -8 : 0)
                }
            }
            Text("\(members.count)人が参加中", bundle: .module)
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                .accessibilityIdentifier("member-count")
        }
    }

    private func avatar(member: InvestigationMember, index: Int) -> some View {
        let colors = DesignTokens.Components.avatarColors
        return ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(colors[index % colors.count].color)
                .frame(width: 28, height: 28)
                .overlay(Circle().stroke(DesignTokens.Colors.surface.color, lineWidth: 2))
                .overlay(
                    Text(String(member.displayName.prefix(1)))
                        .oisintFont(12, .bold)
                        .foregroundStyle(DesignTokens.Colors.surface.color)
                )
            if member.isOnline == true {
                Circle()
                    .fill(DesignTokens.Colors.success.color)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(DesignTokens.Colors.surface.color, lineWidth: 1))
                    .offset(x: 1, y: 1)
            }
        }
        .accessibilityLabel(member.displayName)
    }
}
