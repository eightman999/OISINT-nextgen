import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  anonymousEntitlement,
  freeSnapshot,
  signedOutEntitlement,
  type EntitlementOffering,
  type EntitlementSnapshot,
  type PlusProductId,
  type PurchaseResult,
} from '@/lib/entitlements';
import { WebEntitlementService, type EntitlementService } from '@/lib/entitlementService';
import { useAuth } from '@/providers/AuthProvider';

interface EntitlementContextValue {
  snapshot: EntitlementSnapshot;
  offerings: EntitlementOffering[];
  loading: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  loadOfferings: () => Promise<void>;
  purchase: (productId: PlusProductId) => Promise<PurchaseResult>;
  restore: () => Promise<PurchaseResult>;
}

type AuthIdentityLike = {
  userId: string | null;
  isAnonymous: boolean;
  status?: string;
};

type SnapshotState = {
  subjectKey: string;
  snapshot: EntitlementSnapshot;
};

type OfferingsState = {
  subjectKey: string;
  offerings: EntitlementOffering[];
};

type BooleanState = {
  subjectKey: string;
  value: boolean;
};

function subjectKeyForAuth(auth: AuthIdentityLike): string {
  if (auth.isAnonymous && auth.userId) return `anonymous:${auth.userId}`;
  if (
    auth.userId &&
    auth.status !== 'error' &&
    auth.status !== 'signed_out' &&
    auth.status !== 'disabled'
  ) {
    return `permanent:${auth.userId}`;
  }
  return 'signed_out';
}

function fallbackForSubject(subjectKey: string): EntitlementSnapshot {
  if (subjectKey === 'signed_out') return signedOutEntitlement();
  if (subjectKey.startsWith('anonymous:')) return anonymousEntitlement();
  return freeSnapshot('server_error', 'loading');
}

const EntitlementContext = createContext<EntitlementContextValue>({
  snapshot: signedOutEntitlement(),
  offerings: [],
  loading: false,
  busy: false,
  refresh: async () => {},
  loadOfferings: async () => {},
  purchase: async () => ({ ok: false, kind: 'anonymous', message: '購入にはログインが必要です。' }),
  restore: async () => ({ ok: false, kind: 'anonymous', message: '復元にはログインが必要です。' }),
});

export function EntitlementProvider({
  children,
  service,
}: {
  children: React.ReactNode;
  service?: EntitlementService;
}) {
  const auth = useAuth();
  const stableService = useMemo(() => service ?? new WebEntitlementService(), [service]);
  const subjectKey = subjectKeyForAuth(auth);
  const subjectKeyRef = useRef(subjectKey);
  const identityGenerationRef = useRef(0);
  const [identityState, setIdentityState] = useState({ subjectKey, generation: 0 });
  const identityMatchesRender = identityState.subjectKey === subjectKey;
  // 直前subjectの状態をeffectがリセットする前でも、現在renderはFree/匿名へ倒す。
  const identityGeneration = identityMatchesRender
    ? identityState.generation
    : identityState.generation + 1;
  const [snapshotState, setSnapshotState] = useState<SnapshotState>(() => ({
    subjectKey,
    snapshot: fallbackForSubject(subjectKey),
  }));
  const [offeringsState, setOfferingsState] = useState<OfferingsState>(() => ({
    subjectKey,
    offerings: [],
  }));
  const [loadingState, setLoadingState] = useState<BooleanState>(() => ({ subjectKey, value: false }));
  const [busyState, setBusyState] = useState<BooleanState>(() => ({ subjectKey, value: false }));

  // Reactのeffectが走る前のrenderでも、直前subjectのPlus/offerings/busyを露出させない。
  const snapshot = snapshotState.subjectKey === subjectKey
    ? snapshotState.snapshot
    : fallbackForSubject(subjectKey);
  const offerings = useMemo(
    () => offeringsState.subjectKey === subjectKey ? offeringsState.offerings : [],
    [offeringsState, subjectKey],
  );
  const loading = loadingState.subjectKey === subjectKey ? loadingState.value : true;
  const busy = busyState.subjectKey === subjectKey ? busyState.value : false;

  const isCurrent = useCallback(
    (generation: number, key: string) =>
      identityGenerationRef.current === generation && subjectKeyRef.current === key,
    [],
  );

  useEffect(() => {
    let mounted = true;
    const generation = identityGeneration;
    const currentKey = subjectKey;
    subjectKeyRef.current = currentKey;
    identityGenerationRef.current = generation;
    const identity = {
      userId: currentKey.startsWith('permanent:') ? auth.userId : null,
      isAnonymous: currentKey.startsWith('anonymous:'),
    };
    const current = () => mounted && isCurrent(generation, currentKey);
    const fallback = fallbackForSubject(currentKey);
    const resetState = async () => {
      await Promise.resolve();
      if (!current()) return;
      // stateにもsubject keyを保存するが、表示側は既にrender同期のfallbackを返している。
      setIdentityState({ subjectKey: currentKey, generation });
      setSnapshotState({ subjectKey: currentKey, snapshot: fallback });
      setOfferingsState({ subjectKey: currentKey, offerings: [] });
      setLoadingState({ subjectKey: currentKey, value: true });
      setBusyState({ subjectKey: currentKey, value: false });
    };
    void resetState();
    void stableService.bindIdentity(identity)
      .then((next) => {
        if (current()) setSnapshotState({ subjectKey: currentKey, snapshot: next });
      })
      .catch(() => {
        if (current()) setSnapshotState({ subjectKey: currentKey, snapshot: fallback });
      })
      .finally(() => {
        if (current()) setLoadingState({ subjectKey: currentKey, value: false });
      });
    return () => {
      mounted = false;
      // 認証subjectが変わる前に、古いSDK状態を破棄する。完了通知はcurrent()で遮断する。
      stableService.signOut();
    };
  }, [auth.isAnonymous, auth.userId, identityGeneration, isCurrent, stableService, subjectKey]);

  const refresh = useCallback(async () => {
    const generation = identityGeneration;
    const currentKey = subjectKey;
    if (!isCurrent(generation, currentKey)) return;
    setLoadingState({ subjectKey: currentKey, value: true });
    try {
      const next = await stableService.refresh();
      if (isCurrent(generation, currentKey)) {
        setSnapshotState({ subjectKey: currentKey, snapshot: next });
      }
    } finally {
      if (isCurrent(generation, currentKey)) {
        setLoadingState({ subjectKey: currentKey, value: false });
      }
    }
  }, [identityGeneration, isCurrent, stableService, subjectKey]);

  const loadOfferings = useCallback(async () => {
    const generation = identityGeneration;
    const currentKey = subjectKey;
    setBusyState({ subjectKey: currentKey, value: true });
    try {
      const next = await stableService.offerings();
      if (isCurrent(generation, currentKey)) {
        setOfferingsState({ subjectKey: currentKey, offerings: next });
      }
    } catch {
      if (isCurrent(generation, currentKey)) {
        setOfferingsState({ subjectKey: currentKey, offerings: [] });
      }
    } finally {
      if (isCurrent(generation, currentKey)) {
        setBusyState({ subjectKey: currentKey, value: false });
      }
    }
  }, [identityGeneration, isCurrent, stableService, subjectKey]);

  const purchase = useCallback(async (productId: PlusProductId) => {
    const generation = identityGeneration;
    const currentKey = subjectKey;
    setBusyState({ subjectKey: currentKey, value: true });
    try {
      const result = await stableService.purchase(productId);
      if (!isCurrent(generation, currentKey)) {
        return { ok: false as const, kind: 'failed' as const, message: 'アカウントが切り替わったため購入状態を表示できません。' };
      }
      if (result.ok) setSnapshotState({ subjectKey: currentKey, snapshot: result.snapshot });
      return result;
    } finally {
      if (isCurrent(generation, currentKey)) {
        setBusyState({ subjectKey: currentKey, value: false });
      }
    }
  }, [identityGeneration, isCurrent, stableService, subjectKey]);

  const restore = useCallback(async () => {
    const generation = identityGeneration;
    const currentKey = subjectKey;
    setBusyState({ subjectKey: currentKey, value: true });
    try {
      const result = await stableService.restore();
      if (!isCurrent(generation, currentKey)) {
        return { ok: false as const, kind: 'failed' as const, message: 'アカウントが切り替わったため復元状態を表示できません。' };
      }
      if (result.ok) setSnapshotState({ subjectKey: currentKey, snapshot: result.snapshot });
      return result;
    } finally {
      if (isCurrent(generation, currentKey)) {
        setBusyState({ subjectKey: currentKey, value: false });
      }
    }
  }, [identityGeneration, isCurrent, stableService, subjectKey]);

  const value = useMemo(() => ({
    snapshot,
    offerings,
    loading,
    busy,
    refresh,
    loadOfferings,
    purchase,
    restore,
  }), [snapshot, offerings, loading, busy, refresh, loadOfferings, purchase, restore]);

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  return useContext(EntitlementContext);
}
