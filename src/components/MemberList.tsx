import { StyleSheet, Text, View } from 'react-native';

import { colors, memberAvatarColors, radius } from '@/theme';
import type { InvestigationMember } from '@/types';

interface MemberListProps {
  members: InvestigationMember[];
}

export function MemberList({ members }: MemberListProps) {
  return (
    <View style={styles.container}>
      <View style={styles.avatarRow}>
        {members.map((member, index) => (
          <View
            key={member.id}
            style={[
              styles.avatar,
              { backgroundColor: memberAvatarColors[index % memberAvatarColors.length] },
              index > 0 && styles.avatarOverlap,
            ]}
          >
            <Text style={styles.avatarText}>
              {member.displayName.slice(0, 1)}
            </Text>
            {member.isOnline && <View style={styles.onlineDot} />}
          </View>
        ))}
      </View>
      <Text testID="member-count" style={styles.count}>{members.length}人が参加中</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  avatarOverlap: {
    marginLeft: -8,
  },
  avatarText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '700',
  },
  onlineDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
    borderWidth: 1,
    borderColor: colors.surface,
  },
  count: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
