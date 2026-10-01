import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PLUS_PRODUCT_IDS, type PlusProductId } from '@/lib/entitlements';
import { useAuth } from '@/providers/AuthProvider';
import { useEntitlement } from '@/providers/EntitlementProvider';
import { colors, fonts, radius } from '@/theme';

const PLAN_COPY: Record<PlusProductId, { title: string; period: string }> = {
  [PLUS_PRODUCT_IDS.monthly]: { title: '月額プラン', period: '毎月更新' },
  [PLUS_PRODUCT_IDS.annual]: { title: '年額プラン', period: '毎年更新' },
};

export function PlusPaywall() {
  const auth = useAuth();
  const entitlement = useEntitlement();
  const { loadOfferings } = entitlement;
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (auth.isAuthenticated) void loadOfferings();
  }, [auth.isAuthenticated, loadOfferings]);

  const selectPlan = async (productId: PlusProductId) => {
    setMessage('');
    const result = await entitlement.purchase(productId);
    if (!result.ok) setMessage(result.message);
  };

  const restore = async () => {
    setMessage('');
    const result = await entitlement.restore();
    if (!result.ok) setMessage(result.message);
  };

  return (
    <ScrollView testID="plus-paywall" contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>OISINT PLUS</Text>
        <Text testID="plus-paywall-title" style={styles.title}>Plusのプランと利用条件を確認</Text>
        <Text style={styles.lead}>
          無料プランの調査・投票・根拠確認はそのまま利用できます。Plusの適用範囲と利用枠は、購入前の表示内容とアカウント状態で確認できます。
        </Text>
      </View>

      <View testID="entitlement-status" style={styles.statusCard}>
        <Text style={styles.statusLabel}>現在のプラン</Text>
        <Text style={styles.statusTitle}>{entitlement.snapshot.tier === 'plus' ? 'OISINT Plus' : '無料プラン'}</Text>
        <Text style={styles.statusText}>
          {entitlement.snapshot.tier === 'plus'
            ? entitlement.snapshot.willRenew ? '有効・自動更新あり' : '有効・自動更新なし'
            : '調査と根拠の確認は無料で利用できます。'}
        </Text>
      </View>

      {auth.isAnonymous || !auth.isAuthenticated ? (
        <View testID="plus-paywall-auth-required" style={styles.noticeCard}>
          <Text style={styles.noticeTitle}>購入前にアカウントを接続してください</Text>
          <Text style={styles.noticeText}>
            匿名利用中の購入は受け付けていません。Google連携またはメールログインで恒久アカウントを接続すると、購入状態を安全に引き継げます。
          </Text>
          <Pressable
            testID="plus-paywall-go-account"
            accessibilityRole="button"
            onPress={() => router.push('/account' as never)}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>アカウントを接続する</Text>
          </Pressable>
        </View>
      ) : null}

      {auth.isAuthenticated && entitlement.snapshot.tier !== 'plus' ? (
        <View style={styles.planList}>
          {([PLUS_PRODUCT_IDS.monthly, PLUS_PRODUCT_IDS.annual] as const).map((productId) => {
            const plan = PLAN_COPY[productId];
            const offering = entitlement.offerings.find((item) => item.productId === productId);
            return (
              <View key={productId} testID={`plus-plan-${productId}`} style={styles.planCard}>
                <View style={styles.planText}>
                  <Text style={styles.planTitle}>{plan.title}</Text>
                  <Text style={styles.planPeriod}>{plan.period}</Text>
                </View>
                <Text style={styles.planPrice}>{offering?.price ?? '価格を確認中'}</Text>
                <Pressable
                  testID={`plus-purchase-${productId}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: entitlement.busy || !offering }}
                  disabled={entitlement.busy || !offering}
                  onPress={() => void selectPlan(productId)}
                  style={[styles.planButton, (entitlement.busy || !offering) && styles.disabled]}
                >
                  <Text style={styles.planButtonText}>{entitlement.busy ? '処理中…' : 'このプランを選ぶ'}</Text>
                </Pressable>
              </View>
            );
          })}
          {!entitlement.loading && entitlement.offerings.length === 0 ? (
            <Text testID="plus-offerings-unavailable" style={styles.mutedText}>
              購入プランを取得できませんでした。設定反映後に再読み込みしてください。
            </Text>
          ) : null}
        </View>
      ) : null}

      {auth.isAuthenticated ? (
        <Pressable
          testID="plus-restore"
          accessibilityRole="button"
          accessibilityState={{ disabled: entitlement.busy }}
          disabled={entitlement.busy}
          onPress={() => void restore()}
          style={styles.restoreButton}
        >
          <Text style={styles.restoreButtonText}>購入状態を再確認する</Text>
        </Pressable>
      ) : null}

      {entitlement.loading ? <ActivityIndicator testID="plus-loading" color={colors.orange} /> : null}
      {message ? <Text testID="plus-message" accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
      <View testID="plus-legal-links" style={styles.legalCard}>
        <Text style={styles.legalTitle}>購入前に確認すること</Text>
        <Text style={styles.legalText}>
          価格・契約期間・更新・解約・返金条件は、購入元と下記の案内を確認してください。アカウント削除はストア定期購入の解約ではありません。
        </Text>
        <View style={styles.legalLinks}>
          {[
            ['terms', '利用規約', '/terms'],
            ['privacy', 'プライバシー', '/privacy'],
            ['commercial', '特商法表記', '/commercial-transactions'],
            ['refund', '解約・返金案内', '/support'],
            ['support', 'サポート', '/support'],
          ].map(([id, label, path]) => (
            <Pressable
              key={id}
              accessibilityRole="link"
              testID={`plus-legal-${id}`}
              onPress={() => router.push(path as never)}
              style={styles.legalLink}
            >
              <Text style={styles.legalLinkText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
        <Text style={styles.backButtonText}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: 16, padding: 24, backgroundColor: colors.bg },
  header: { maxWidth: 680, alignSelf: 'center', width: '100%', gap: 8, paddingTop: 18 },
  kicker: { color: colors.orange, fontFamily: fonts.brand, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', lineHeight: 40 },
  lead: { color: colors.textSecondary, fontSize: 14, lineHeight: 22 },
  statusCard: { maxWidth: 680, alignSelf: 'center', width: '100%', gap: 6, padding: 18, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  statusLabel: { color: colors.textTertiary, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  statusTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  statusText: { color: colors.textSecondary, fontSize: 12 },
  noticeCard: { maxWidth: 680, alignSelf: 'center', width: '100%', gap: 10, padding: 18, borderRadius: radius.md, backgroundColor: colors.warningSoft },
  noticeTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  noticeText: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  primaryButton: { alignSelf: 'flex-start', minHeight: 42, justifyContent: 'center', paddingHorizontal: 18, borderRadius: radius.sm, backgroundColor: colors.orange },
  primaryButtonText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  planList: { maxWidth: 680, alignSelf: 'center', width: '100%', gap: 12 },
  planCard: { gap: 10, padding: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  planText: { flex: 1, minWidth: 130, gap: 4 },
  planTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  planPeriod: { color: colors.textSecondary, fontSize: 11 },
  planPrice: { color: colors.text, fontSize: 15, fontWeight: '800' },
  planButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.sm, backgroundColor: colors.orange },
  planButtonText: { color: colors.white, fontSize: 11, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  mutedText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  restoreButton: { alignSelf: 'center', padding: 10 },
  restoreButtonText: { color: colors.info, fontSize: 12, fontWeight: '700' },
  message: { maxWidth: 680, alignSelf: 'center', width: '100%', color: colors.warning, fontSize: 12, lineHeight: 18 },
  legalCard: { maxWidth: 680, alignSelf: 'center', width: '100%', gap: 8, padding: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  legalTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  legalText: { color: colors.textSecondary, fontSize: 11, lineHeight: 17 },
  legalLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  legalLink: { paddingVertical: 5, paddingHorizontal: 8 },
  legalLinkText: { color: colors.info, fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' },
  backButton: { alignSelf: 'center', padding: 10 },
  backButtonText: { color: colors.textSecondary, fontSize: 12 },
});
