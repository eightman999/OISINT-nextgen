import { useCallback, useState } from 'react';

import { buildShareUrl } from '@/lib/shareUrl';

interface Input {
  investigationId: string;
  subjectKey: string;
  paramToken?: string;
  investigationShareToken?: string;
}

interface ShareState {
  scope: string;
  generation: object;
  observedToken?: string;
  rotatedToken?: string;
  supersededTokens: string[];
}

function initialState(scope: string, observedToken?: string): ShareState {
  return { scope, generation: {}, observedToken, supersededTokens: [] };
}

/** Reconcile successful local rotations with fetched tokens, never with route parameters. */
export function useInvestigationShareUrl({
  investigationId,
  subjectKey,
  paramToken,
  investigationShareToken,
}: Input) {
  const scope = JSON.stringify([investigationId, subjectKey]);
  const [state, setState] = useState(() => initialState(scope, investigationShareToken));
  let current = state;

  // Reset before rendering another investigation/subject, not in a later effect.
  if (state.scope !== scope) {
    current = initialState(scope, investigationShareToken);
    setState(current);
  } else if (state.observedToken !== investigationShareToken) {
    current = { ...state, observedToken: investigationShareToken };
    if (state.rotatedToken && investigationShareToken &&
        investigationShareToken !== state.rotatedToken &&
        !state.supersededTokens.includes(investigationShareToken)) {
      // A different canonical token can be a subsequent rotation on another device.
      current = {
        ...current,
        rotatedToken: investigationShareToken,
        supersededTokens: [...state.supersededTokens, state.rotatedToken],
      };
    }
    setState(current);
  }

  const generation = current.generation;
  const onRotated = useCallback((newToken: string) => {
    if (!newToken) return;
    setState((previous) => {
      // Discard a delayed result from an earlier investigation/auth generation,
      // including A -> B -> A without an unmount.
      if (previous.generation !== generation) return previous;
      return {
        ...previous,
        rotatedToken: newToken,
        supersededTokens: [...new Set([
          ...previous.supersededTokens,
          previous.observedToken,
          previous.rotatedToken,
        ].filter((token): token is string => Boolean(token) && token !== newToken))],
      };
    });
  }, [generation]);

  return {
    shareUrl: buildShareUrl({
      investigationId,
      paramToken,
      investigationShareToken: current.rotatedToken || investigationShareToken,
    }),
    onRotated,
  };
}
