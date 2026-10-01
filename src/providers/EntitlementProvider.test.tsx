// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  anonymousEntitlement,
  freeSnapshot,
  signedOutEntitlement,
  type EntitlementOffering,
  type EntitlementSnapshot,
  type PurchaseResult,
} from '@/lib/entitlements';
import type { EntitlementIdentity, EntitlementService } from '@/lib/entitlementService';
import { EntitlementProvider, useEntitlement } from '@/providers/EntitlementProvider';

const authMock = vi.hoisted(() => ({
  state: { userId: '00000000-0000-4000-8000-000000000601' as string | null, isAnonymous: false },
}));

vi.mock('@/providers/AuthProvider', () => ({
  useAuth: () => authMock.state,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe() {
  const { snapshot, loading } = useEntitlement();
  return (
    <>
      <span data-testid="tier">{snapshot.tier}</span>
      <span data-testid="reason">{snapshot.reason ?? ''}</span>
      <span data-testid="loading">{String(loading)}</span>
    </>
  );
}

function OperationProbe() {
  const { snapshot, offerings, loading, busy, refresh, loadOfferings, purchase, restore } = useEntitlement();
  return (
    <>
      <span data-testid="tier">{snapshot.tier}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="offerings">{offerings.map((item) => item.productId).join(',')}</span>
      <button data-testid="refresh" onClick={() => void refresh()}>refresh</button>
      <button data-testid="offerings-button" onClick={() => void loadOfferings()}>offerings</button>
      <button data-testid="purchase" onClick={() => void purchase('oisint_plus_monthly')}>purchase</button>
      <button data-testid="restore" onClick={() => void restore()}>restore</button>
    </>
  );
}

function makeService(bindIdentity: (identity: EntitlementIdentity) => Promise<EntitlementSnapshot>) {
  return {
    snapshot: signedOutEntitlement(),
    bindIdentity: vi.fn(bindIdentity),
    refresh: vi.fn(async () => freeSnapshot()),
    offerings: vi.fn(async () => []),
    purchase: vi.fn(async () => ({
      ok: false as const,
      kind: 'failed' as const,
      message: 'fixture',
    })),
    restore: vi.fn(async () => ({
      ok: false as const,
      kind: 'failed' as const,
      message: 'fixture',
    })),
    signOut: vi.fn(),
  } satisfies EntitlementService;
}

describe('EntitlementProvider identity fail-closed boundary', () => {
  beforeEach(() => {
    authMock.state = {
      userId: '00000000-0000-4000-0000-000000000601',
      isAnonymous: false,
    };
  });

  afterEach(() => cleanup());

  it('drops a prior Plus snapshot before B resolves and ignores late A resolution', async () => {
    const bindA = deferred<EntitlementSnapshot>();
    const bindB = deferred<EntitlementSnapshot>();
    const service = makeService((identity) =>
      identity.userId === '00000000-0000-4000-0000-000000000601'
        ? bindA.promise
        : bindB.promise,
    );
    const view = render(
      <EntitlementProvider service={service}>
        <Probe />
      </EntitlementProvider>,
    );

    authMock.state = {
      userId: '00000000-0000-4000-0000-000000000602',
      isAnonymous: false,
    };
    view.rerender(
      <EntitlementProvider service={service}>
        <Probe />
      </EntitlementProvider>,
    );
    // effect/microtaskを待たず、同じrender直後に旧Plusを隠す。
    expect(view.getByTestId('tier').textContent).toBe('free');
    await waitFor(() => expect(view.getByTestId('tier').textContent).toBe('free'));

    await act(async () => {
      bindA.resolve({
        ...freeSnapshot(),
        tier: 'plus',
        state: 'plus',
        lifecycle: 'active',
        productId: 'oisint_plus_monthly',
      });
      await Promise.resolve();
    });
    expect(view.getByTestId('tier').textContent).toBe('free');
    bindB.resolve(freeSnapshot());
  });

  it('blocks every stale provider operation after an account switch', async () => {
    const bindA = deferred<EntitlementSnapshot>();
    const bindB = deferred<EntitlementSnapshot>();
    const refreshA = deferred<EntitlementSnapshot>();
    const offeringsA = deferred<EntitlementOffering[]>();
    const purchaseA = deferred<PurchaseResult>();
    const restoreA = deferred<PurchaseResult>();
    let bindCalls = 0;
    const service = {
      snapshot: signedOutEntitlement(),
      bindIdentity: vi.fn(() => ++bindCalls === 1 ? bindA.promise : bindB.promise),
      refresh: vi.fn(() => refreshA.promise),
      offerings: vi.fn(() => offeringsA.promise),
      purchase: vi.fn(() => purchaseA.promise),
      restore: vi.fn(() => restoreA.promise),
      signOut: vi.fn(),
    } satisfies EntitlementService;
    const view = render(
      <EntitlementProvider service={service}>
        <OperationProbe />
      </EntitlementProvider>,
    );

    await act(async () => {
      bindA.resolve(freeSnapshot());
      await Promise.resolve();
    });
    fireEvent.click(view.getByTestId('refresh'));
    fireEvent.click(view.getByTestId('offerings-button'));
    fireEvent.click(view.getByTestId('purchase'));
    fireEvent.click(view.getByTestId('restore'));
    expect(view.getByTestId('busy').textContent).toBe('true');

    authMock.state = {
      userId: '00000000-0000-4000-0000-000000000602',
      isAnonymous: false,
    };
    view.rerender(
      <EntitlementProvider service={service}>
        <OperationProbe />
      </EntitlementProvider>,
    );
    expect(view.getByTestId('tier').textContent).toBe('free');
    expect(view.getByTestId('offerings').textContent).toBe('');
    expect(view.getByTestId('busy').textContent).toBe('false');

    await act(async () => {
      refreshA.resolve({ ...freeSnapshot(), tier: 'plus', state: 'plus', productId: 'oisint_plus_monthly' });
      offeringsA.resolve([{
        productId: 'oisint_plus_monthly',
        packageId: 'pkg-a',
        title: 'A',
        price: '$1',
        period: 'month',
      }]);
      purchaseA.resolve({ ok: true, snapshot: { ...freeSnapshot(), tier: 'plus', state: 'plus', productId: 'oisint_plus_monthly' } });
      restoreA.resolve({ ok: true, snapshot: { ...freeSnapshot(), tier: 'plus', state: 'plus', productId: 'oisint_plus_monthly' } });
      await Promise.resolve();
    });
    expect(view.getByTestId('tier').textContent).toBe('free');
    expect(view.getByTestId('offerings').textContent).toBe('');
    bindB.resolve(freeSnapshot());
    await waitFor(() => expect(view.getByTestId('busy').textContent).toBe('false'));
  });

  it.each([
    ['anonymous', { userId: '00000000-0000-4000-0000-000000000603', isAnonymous: true } as EntitlementIdentity, anonymousEntitlement()],
    ['signed out', { userId: null, isAnonymous: false } as EntitlementIdentity, signedOutEntitlement()],
  ])('fails closed when switching from Plus to %s', async (_label, nextIdentity, expected) => {
    const bindA = deferred<EntitlementSnapshot>();
    const bindNext = deferred<EntitlementSnapshot>();
    let calls = 0;
    const service = makeService(() => {
      calls += 1;
      return calls === 1 ? bindA.promise : bindNext.promise;
    });
    const view = render(
      <EntitlementProvider service={service}>
        <Probe />
      </EntitlementProvider>,
    );

    authMock.state = nextIdentity;
    view.rerender(
      <EntitlementProvider service={service}>
        <Probe />
      </EntitlementProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId('tier').textContent).toBe(expected.tier);
      expect(view.getByTestId('reason').textContent).toBe(expected.reason ?? '');
    });

    await act(async () => {
      bindA.resolve({
        ...freeSnapshot(),
        tier: 'plus',
        state: 'plus',
        lifecycle: 'active',
        productId: 'oisint_plus_annual',
      });
      await Promise.resolve();
    });
    expect(view.getByTestId('tier').textContent).toBe(expected.tier);
    bindNext.resolve(expected);
  });
});
