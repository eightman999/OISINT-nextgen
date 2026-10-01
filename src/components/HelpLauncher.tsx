import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ElementRef } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius } from '@/theme';

const HELP_LINKS = [
  {
    destination: 'help',
    path: '/help',
    label: '使い方を見る',
    description: '最初の使い方と候補の読み方を確認する',
  },
  {
    destination: 'support',
    path: '/support',
    label: 'よくある質問',
    description: '困ったときの答えとサポート窓口を見る',
  },
  {
    destination: 'feedback',
    path: '/feedback',
    label: 'フィードバック',
    description: 'わかりにくかったところや改善案を送る',
  },
  {
    destination: 'contact',
    path: '/contact',
    label: 'お問い合わせ',
    description: '確認したいことを問い合わせる',
  },
] as const;

export type HelpDestination = (typeof HELP_LINKS)[number]['destination'];
export type HelpLauncherEvent =
  | { name: 'help_launcher_impression' }
  | { name: 'help_launcher_opened' }
  | { name: 'help_link_clicked'; destination: HelpDestination }
  | { name: 'help_sheet_closed' };

export interface HelpLauncherProps {
  /**
   * analytics基盤が接続されるまでのテスト可能な境界。
   * 入力本文・raw query・位置情報はこのcallbackへ渡さない。
   */
  onEvent?: (event: HelpLauncherEvent) => void;
}

type HelpPath = (typeof HELP_LINKS)[number]['path'];
type FocusableRef = ElementRef<typeof Pressable>;
type DockPosition = { left: number; top: number };

const HISTORY_MARKER = '__oisintHelpLauncher';
const TRIGGER_WIDTH = 92;
const COMPACT_TRIGGER_WIDTH = 44;
const TRIGGER_HEIGHT = 44;

/**
 * Mobile Web向けの小型ヘルプ入口。
 *
 * RootLayoutから一度だけ描画し、既存Footerと公開routeを再利用する。
 * sheetを開くと同一URLのhistory entryを1つ積むため、browser Backは
 * route遷移ではなくsheetを閉じる操作としても機能する。
 */
export function HelpLauncher({ onEvent }: HelpLauncherProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [dockPosition, setDockPosition] = useState<DockPosition>({ left: 12, top: 12 });
  const openRef = useRef(false);
  const historyEntryRef = useRef(false);
  const pendingNavigationRef = useRef<HelpPath | null>(null);
  const closeRequestRef = useRef(0);
  const triggerRef = useRef<FocusableRef>(null);
  const closeRef = useRef<FocusableRef>(null);
  const modalRef = useRef<View>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const emit = useCallback((event: HelpLauncherEvent) => {
    onEventRef.current?.(event);
  }, []);

  const updateDockPosition = useCallback(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const viewportWidth = window.innerWidth || width;
    const viewportHeight = window.innerHeight || height;
    const compactTrigger = width < 600;
    const triggerWidth = compactTrigger ? COMPACT_TRIGGER_WIDTH : TRIGGER_WIDTH;
    const horizontalInset = compactTrigger ? Math.max(0, insets.left) : Math.max(24, insets.left + 24);
    const trailingInset = compactTrigger ? Math.max(0, insets.right) : Math.max(24, insets.right + 24);
    const topInset = Math.max(12, insets.top + 10);
    const bottomInset = Math.max(14, insets.bottom + 10);
    const bottomTop = Math.max(topInset, viewportHeight - bottomInset - TRIGGER_HEIGHT);
    const rightLeft = Math.max(horizontalInset, viewportWidth - trailingInset - triggerWidth);
    const scanStep = 56;
    const scanPositions = Array.from(
      { length: Math.floor((bottomTop - topInset) / scanStep) + 1 },
      (_, index) => Math.min(bottomTop, topInset + index * scanStep),
    );
    const verticalPositions = Array.from(
      new Set([bottomTop, topInset, Math.max(topInset, (viewportHeight - TRIGGER_HEIGHT) / 2), ...scanPositions]),
    );
    const candidates: DockPosition[] = verticalPositions.flatMap((top) => [
      { left: horizontalInset, top },
      { left: rightLeft, top },
    ]);

    const obstacleElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="home-query"], [data-testid="home-start"], [data-testid="join-button"], [data-testid="contact-submit"], [data-testid="feedback-submit"], button, a, input, textarea, select, [role], [tabindex]',
      ),
    ).filter((element, index, elements) => {
      // 同じ要素を複数selectorで拾わず、launcher自身を候補の障害物から除外する。
      if (elements.indexOf(element) !== index || element.closest('[data-testid="help-launcher"]')) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const computed = window.getComputedStyle(element);
      return (
        computed.display !== 'none' &&
        computed.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < viewportHeight
      );
    });
    const obstacleRects = obstacleElements.map((element) => element.getBoundingClientRect());
    const collisionScore = (candidate: DockPosition) =>
      obstacleRects.reduce((score, rect) => {
        const overlapWidth = Math.max(
          0,
          Math.min(candidate.left + triggerWidth, rect.right + 8) -
            Math.max(candidate.left, rect.left - 8),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(candidate.top + TRIGGER_HEIGHT, rect.bottom + 8) -
            Math.max(candidate.top, rect.top - 8),
        );
        return score + overlapWidth * overlapHeight;
      }, 0);
    const next = candidates.reduce((best, candidate) =>
      collisionScore(candidate) < collisionScore(best) ? candidate : best,
    );
    setDockPosition((previous) =>
      previous.left === next.left && previous.top === next.top ? previous : next,
    );
  }, [height, insets.bottom, insets.left, insets.right, insets.top, width]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    emit({ name: 'help_launcher_impression' });
  }, [emit]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const updateKeyboardState = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const keyboardOpen = window.innerHeight - viewportHeight > 120;
      setKeyboardVisible(keyboardOpen);
    };

    updateKeyboardState();
    window.addEventListener('resize', updateKeyboardState);
    window.visualViewport?.addEventListener('resize', updateKeyboardState);
    return () => {
      window.removeEventListener('resize', updateKeyboardState);
      window.visualViewport?.removeEventListener('resize', updateKeyboardState);
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const initialUpdateTimer = window.setTimeout(updateDockPosition, 0);
    window.addEventListener('resize', updateDockPosition);
    // React Native WebのScrollViewはwindow以外をscrollするためcaptureで拾う。
    window.addEventListener('scroll', updateDockPosition, true);
    return () => {
      window.clearTimeout(initialUpdateTimer);
      window.removeEventListener('resize', updateDockPosition);
      window.removeEventListener('scroll', updateDockPosition, true);
    };
  }, [updateDockPosition]);

  const focusPrevious = useCallback(() => {
    if (Platform.OS !== 'web') {
      triggerRef.current?.focus();
      return;
    }

    const focusWhenReady = (attempt: number) => {
      const previous = previouslyFocusedRef.current;
      if (previous?.isConnected && !previous.hasAttribute('disabled')) {
        previous.focus({ preventScroll: true });
        return;
      }
      const triggerElement = document.querySelector<HTMLElement>(
        '[data-testid="help-launcher-trigger"]',
      );
      if (triggerElement && !triggerElement.hasAttribute('disabled')) {
        triggerElement.focus({ preventScroll: true });
        return;
      }
      // state commitでdisabled/tabIndexが戻るまで短く再試行する。
      if (attempt < 10 && typeof window !== 'undefined') {
        window.setTimeout(() => focusWhenReady(attempt + 1), 16);
      }
    };
    focusWhenReady(0);
  }, []);

  const completeClose = useCallback(
    (navigation?: HelpPath) => {
      openRef.current = false;
      historyEntryRef.current = false;
      pendingNavigationRef.current = null;
      setOpen(false);
      emit({ name: 'help_sheet_closed' });
      focusPrevious();

      // sheetを閉じた後にだけrouteへ進む。route failureでも空sheetを残さない。
      if (navigation) router.push({ pathname: navigation } as never);
    },
    [emit, focusPrevious],
  );

  const requestClose = useCallback(
    (navigation?: HelpPath) => {
      if (!openRef.current) return;
      pendingNavigationRef.current = navigation ?? null;

      if (Platform.OS !== 'web' || typeof window === 'undefined' || !historyEntryRef.current) {
        completeClose(navigation);
        return;
      }

      const requestId = closeRequestRef.current + 1;
      closeRequestRef.current = requestId;
      window.history.back();

      // jsdomや一部WebViewはpopstateの通知が遅延/省略されることがあるため、
      // history entryが残ったままならfail-openせずsheetを閉じるfallbackを持つ。
      window.setTimeout(() => {
        if (
          openRef.current &&
          historyEntryRef.current &&
          closeRequestRef.current === requestId
        ) {
          const pending = pendingNavigationRef.current ?? undefined;
          completeClose(pending);
        }
      }, 500);
    },
    [completeClose],
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !open) return;

    const handlePopState = () => {
      const pending = pendingNavigationRef.current ?? undefined;
      completeClose(pending);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [completeClose, open]);

  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const modal = modalRef.current as unknown as HTMLElement | null;
      if (!modal) return;
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, requestClose]);

  const openSheet = () => {
    if (openRef.current) return;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const state = window.history.state;
      const nextState = state && typeof state === 'object' ? { ...state } : {};
      (nextState as Record<string, unknown>)[HISTORY_MARKER] = true;
      window.history.pushState(nextState, '', window.location.href);
      historyEntryRef.current = true;
    }
    openRef.current = true;
    setOpen(true);
    emit({ name: 'help_launcher_opened' });
  };

  const handleDestination = (destination: (typeof HELP_LINKS)[number]) => {
    emit({ name: 'help_link_clicked', destination: destination.destination });
    requestClose(destination.path);
  };

  if (Platform.OS !== 'web') return null;

  const sheetHeight = Math.max(260, Math.min(620, height - Math.max(24, insets.bottom + 24)));
  const fixedWebStyle = { position: 'fixed' as const } as unknown as ViewStyle;

  return (
    <View
      testID="help-launcher"
      style={[styles.root, fixedWebStyle]}
    >
      {!keyboardVisible ? (
        <Pressable
          ref={triggerRef}
          testID="help-launcher-trigger"
          accessibilityRole="button"
          accessibilityLabel="ヘルプとサポートを開く"
          accessibilityHint="使い方、よくある質問、お問い合わせを開きます"
          onPress={openSheet}
          disabled={open}
          tabIndex={open ? -1 : 0}
          aria-hidden={open}
          style={[
            styles.trigger,
            width < 600 && styles.triggerCompact,
            { top: dockPosition.top, left: dockPosition.left },
            open && styles.triggerHidden,
          ]}
        >
          <Text style={styles.triggerMark}>?</Text>
          {width >= 600 ? <Text style={styles.triggerText}>ヘルプ</Text> : null}
        </Pressable>
      ) : null}

      {open ? (
        <View
          testID="help-launcher-overlay"
          style={[
            styles.overlay,
            fixedWebStyle,
            { paddingBottom: Math.max(18, insets.bottom + 12) },
          ]}
          accessibilityViewIsModal
        >
          <Pressable
            testID="help-launcher-backdrop"
            accessibilityRole="button"
            accessibilityLabel="ヘルプを閉じる"
            onPress={() => requestClose()}
            tabIndex={-1}
            style={styles.backdrop}
          />
          <View
            ref={modalRef}
            testID="help-launcher-sheet"
            role="dialog"
            accessibilityLabel="ヘルプとサポート"
            aria-modal={true}
            style={[styles.sheet, { height: sheetHeight, maxHeight: sheetHeight }]}
          >
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeading}>
                <Text style={styles.eyebrow}>HELP / SUPPORT</Text>
                <Text testID="help-launcher-title" style={styles.title}>
                  どこから見る？
                </Text>
              </View>
              <Pressable
                ref={closeRef}
                testID="help-launcher-close"
                accessibilityRole="button"
                accessibilityLabel="ヘルプを閉じる"
                onPress={() => requestClose()}
                style={styles.closeButton}
              >
                <Text style={styles.closeText}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.description}>
              今の画面を離れずに、必要な入口を選べます。
            </Text>
            <ScrollView
              testID="help-launcher-links"
              style={styles.linksScroll}
              contentContainerStyle={styles.linksContent}
              keyboardShouldPersistTaps="handled"
            >
              {HELP_LINKS.map((destination) => (
                <Pressable
                  key={destination.destination}
                  testID={`help-launcher-link-${destination.destination}`}
                  accessibilityRole="link"
                  accessibilityLabel={`${destination.label}。${destination.description}`}
                  onPress={() => handleDestination(destination)}
                  style={styles.link}
                >
                  <View style={styles.linkCopy}>
                    <Text style={styles.linkLabel}>{destination.label}</Text>
                    <Text style={styles.linkDescription}>{destination.description}</Text>
                  </View>
                  <Text style={styles.linkArrow}>→</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.footerNote}>入力内容や位置情報はこの入口から送信されません。</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    pointerEvents: 'box-none',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 90,
  },
  trigger: {
    position: 'absolute',
    minWidth: 92,
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.black,
    backgroundColor: colors.surface,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  },
  triggerCompact: {
    width: COMPACT_TRIGGER_WIDTH,
    minWidth: COMPACT_TRIGGER_WIDTH,
    paddingHorizontal: 0,
    gap: 0,
  },
  triggerMark: {
    width: 20,
    height: 20,
    lineHeight: 20,
    borderRadius: radius.pill,
    textAlign: 'center',
    color: colors.surface,
    backgroundColor: colors.orange,
    fontSize: 13,
    fontWeight: '800',
  },
  triggerText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  triggerHidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(29, 41, 35, 0.48)',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    zIndex: 1,
    width: '94%',
    maxWidth: 460,
    padding: 18,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.24)',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  sheetHeading: {
    flexShrink: 1,
    gap: 4,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: fonts.brand,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
  },
  closeButton: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.canvas,
  },
  closeText: {
    color: colors.text,
    fontSize: 24,
    lineHeight: 26,
    fontWeight: '500',
  },
  description: {
    marginTop: 8,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 19,
  },
  linksScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    maxHeight: 330,
    marginTop: 12,
  },
  linksContent: {
    gap: 8,
  },
  link: {
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.canvas,
  },
  linkCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  linkLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  linkDescription: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  linkArrow: {
    color: colors.orange,
    fontSize: 20,
    fontWeight: '700',
  },
  footerNote: {
    marginTop: 12,
    color: colors.textTertiary,
    fontSize: 10,
    lineHeight: 15,
  },
});
