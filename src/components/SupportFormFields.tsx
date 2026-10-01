import {
  KeyboardTypeOptions,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, supportColors } from '@/theme';

export function SupportField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  testID,
  multiline = false,
  keyboardType = 'default',
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  testID: string;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldLabelRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        multiline={multiline}
        keyboardType={keyboardType}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[styles.input, multiline && styles.inputMultiline]}
      />
    </View>
  );
}

export function SupportChoiceGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string; description?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choiceList}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              aria-checked={active}
              onPress={() => onChange(option.value)}
              style={[styles.choice, active && styles.choiceActive]}
            >
              <View style={[styles.choiceDot, active && styles.choiceDotActive]} />
              <View style={styles.choiceBody}>
                <Text style={[styles.choiceLabel, active && styles.choiceLabelActive]}>
                  {option.label}
                </Text>
                {option.description ? (
                  <Text style={styles.choiceDescription}>{option.description}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SupportNotice({ tone, children }: { tone: 'error' | 'success'; children: string }) {
  return (
    <View style={[styles.notice, tone === 'error' ? styles.noticeError : styles.noticeSuccess]}>
      <Text style={[styles.noticeIcon, tone === 'error' ? styles.noticeErrorText : styles.noticeSuccessText]}>
        {tone === 'error' ? '!' : '✓'}
      </Text>
      <Text style={[styles.noticeText, tone === 'error' ? styles.noticeErrorText : styles.noticeSuccessText]}>
        {children}
      </Text>
    </View>
  );
}

export function SupportSubmitButton({
  label,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.submitButton, disabled && styles.submitButtonDisabled, pressed && !disabled && styles.submitButtonPressed]}
    >
      <Text style={styles.submitButtonText}>{label}</Text>
    </Pressable>
  );
}

export function SupportPrivacyNote() {
  return (
    <View style={styles.privacyNote}>
      <Text style={styles.privacyIcon}>◇</Text>
      <Text style={styles.privacyText}>
        パスワード・カード番号・正確な現在地などの秘密情報は入力しないでください。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 7,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
  },
  fieldLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  fieldHint: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  input: {
    minHeight: 48,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 13,
  },
  inputMultiline: {
    minHeight: 150,
  },
  choiceList: {
    gap: 7,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  choiceActive: {
    borderColor: colors.orange,
    backgroundColor: colors.activeBg,
  },
  choiceDot: {
    width: 16,
    height: 16,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceDotActive: {
    borderWidth: 5,
    borderColor: colors.orange,
  },
  choiceBody: {
    flex: 1,
    gap: 2,
  },
  choiceLabel: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  choiceLabelActive: {
    color: colors.orange,
  },
  choiceDescription: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  noticeError: {
    borderColor: supportColors.errorBorder,
    backgroundColor: colors.dangerSoft,
  },
  noticeSuccess: {
    borderColor: supportColors.successBorder,
    backgroundColor: colors.successSoft,
  },
  noticeIcon: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  noticeText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 18,
    fontWeight: '700',
  },
  noticeErrorText: {
    color: colors.danger,
  },
  noticeSuccessText: {
    color: colors.success,
  },
  submitButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.black,
  },
  submitButtonDisabled: {
    backgroundColor: colors.border,
  },
  submitButtonPressed: {
    opacity: 0.8,
  },
  submitButtonText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '800',
  },
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 2,
  },
  privacyIcon: {
    color: colors.textTertiary,
    fontSize: 15,
  },
  privacyText: {
    flex: 1,
    color: colors.textTertiary,
    fontSize: 10,
    lineHeight: 16,
  },
});
