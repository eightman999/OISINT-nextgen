import Head from 'expo-router/head';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Footer } from '@/components/Footer';
import { PublicCandidateCard } from '@/components/VisibilityToggle';
import { getPublicInvestigation } from '@/lib/api';
import { colors, radius } from '@/theme';
import type { PublicInvestigation } from '@/types';

// 公開 Investigation の閲覧ページ（issue #115 / §3 P1, §33）。
// visibility='public' の調査だけを、raw_query・requirement 文面・投票なしの
// 安全な最小集合で表示する。
export default function PublicInvestigationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [investigation, setInvestigation] = useState<PublicInvestigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let mounted = true;
    // effect 本体で同期 setState せず、microtask 境界の後に初期読込を順序化する。
    void Promise.resolve().then(() => {
      if (!mounted) return;
      if (!id) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setLoading(true);
      setNotFound(false);
      getPublicInvestigation(id)
        .then((result) => {
          if (!mounted) return;
          setInvestigation(result ?? null);
          setNotFound(!result);
          setLoading(false);
        })
        .catch(() => {
          // 失敗理由は漏らさず「閲覧できません」として扱う（§33）
          if (!mounted) return;
          setInvestigation(null);
          setNotFound(true);
          setLoading(false);
        });
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  return (
    <View style={styles.wrapper}>
      {/* 公開ページも検索エンジン露出を意図しない（#179 / §8） */}
      <Head>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scroll}>
        {loading ? (
          <View style={styles.center}>
            <Text style={styles.muted}>読み込んでいます…</Text>
          </View>
        ) : notFound || !investigation ? (
          <View style={styles.center}>
            <Text testID="pub-not-found" accessibilityRole="alert" style={styles.notFoundTitle}>
              この調査は閲覧できません
            </Text>
            <Text style={styles.notFoundText}>
              非公開に設定されているか、リンクが無効です。
            </Text>
          </View>
        ) : (
          <View testID="pub-investigation" style={styles.body}>
            <Text style={styles.title}>{investigation.title}</Text>
            <Text style={styles.meta}>
              公開された店探し調査 / 調査完了日 {formatDate(investigation.createdAt)}
            </Text>
            <Text style={styles.disclosure}>
              このページには候補と根拠だけを表示しています。検索文・条件の文面・投票は表示されません。
            </Text>
            <View style={styles.candidateList}>
              {investigation.candidates.length > 0 ? (
                investigation.candidates.map((candidate) => (
                  <PublicCandidateCard key={candidate.id} candidate={candidate} />
                ))
              ) : (
                <Text style={styles.muted}>候補がありません。</Text>
              )}
            </View>
          </View>
        )}
      </ScrollView>
      <Footer />
    </View>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
  },
  scroll: {
    padding: 20,
    gap: 16,
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },
  center: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  muted: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  notFoundTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  notFoundText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  body: {
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    letterSpacing: -0.5,
    color: colors.text,
  },
  meta: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  disclosure: {
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    fontSize: 11,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  candidateList: {
    gap: 12,
  },
});
