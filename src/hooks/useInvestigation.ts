import { useCallback, useEffect, useRef, useState } from 'react';

import { getInvestigation, getInvestigationAsync, isLiveDataProvider, subscribeInvestigation } from '@/lib/api';
import type { Investigation } from '@/types';

export function useInvestigation(
  investigationId: string | undefined,
  subjectKey = 'unscoped-preview',
) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const identityRef = useRef({ key: subjectKey, generation: 0 });
  const [identityState, setIdentityState] = useState({ key: subjectKey, generation: 0 });
  // state key mismatch is the render-synchronous fail-closed gate. The ref is only
  // synchronized from the effect, never read or mutated during render.
  const visibleForSubject = identityState.key === subjectKey;
  const identityGeneration = visibleForSubject
    ? identityState.generation
    : identityState.generation + 1;

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    const generation = identityGeneration;
    identityRef.current = { key: subjectKey, generation };
    const isCurrent = () =>
      mounted &&
      identityRef.current.key === subjectKey &&
      identityRef.current.generation === generation;

    // effect本体で同期setStateせず、microtask境界の後にID切替→初期読込→購読を順序化する。
    const load = async () => {
      await Promise.resolve();
      if (!isCurrent()) return;

      setIdentityState({ key: subjectKey, generation });
      setInvestigation(null);
      setError(null);
      setLoading(true);

      if (!investigationId) {
        setError('調査IDが指定されていません');
        setLoading(false);
        return;
      }

      try {
        // 明示されたsubjectでは同期seed/cacheを信用しない。Aのprivate snapshotを
        // B/匿名/サインアウトへ一瞬でも再表示せず、現在subjectの非同期/RLS結果だけを採用する。
        if (subjectKey === 'unscoped-preview') {
          const initial = getInvestigation(investigationId);
          if (initial) {
            setInvestigation(initial);
            setLoading(false);
          } else if (!isLiveDataProvider) {
            setError('調査が見つかりません');
            setLoading(false);
          }
        }

        unsubscribe = subscribeInvestigation(investigationId, (next) => {
          if (!isCurrent()) return;
          setInvestigation(next);
          setError(null);
          setLoading(false);
        });

        if (isLiveDataProvider || subjectKey !== 'unscoped-preview') {
          void getInvestigationAsync(investigationId)
            .then((next) => {
              if (!isCurrent()) return;
              if (next) {
                setInvestigation(next);
                setError(null);
              } else {
                setError('調査が見つかりません');
              }
              setLoading(false);
            })
            .catch(() => {
              if (!isCurrent()) return;
              setError('調査データを読み込めませんでした');
              setLoading(false);
            });
        }
      } catch {
        if (isCurrent()) {
          setError('調査データを読み込めませんでした');
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [identityGeneration, investigationId, retryCount, subjectKey]);

  const retry = useCallback(() => setRetryCount((current) => current + 1), []);

  return {
    investigation: visibleForSubject ? investigation : null,
    loading: visibleForSubject ? loading : true,
    error: visibleForSubject ? error : null,
    retry,
  };
}
