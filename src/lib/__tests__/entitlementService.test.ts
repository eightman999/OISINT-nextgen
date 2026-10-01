import { describe, expect, it, vi } from 'vitest';

import { WebEntitlementService } from '@/lib/entitlementService';
import { PLUS_PRODUCT_IDS } from '@/lib/entitlements';

const firstUser = '00000000-0000-4000-8000-000000000571';
const secondUser = '00000000-0000-4000-8000-000000000572';

function row(userId: string) {
  return {
    user_id: userId,
    entitlement_id: 'plus',
    offering_id: 'default',
    product_id: PLUS_PRODUCT_IDS.monthly,
    app_user_id: userId,
    store: 'TEST_STORE',
    environment: 'SANDBOX',
    is_active: true,
    lifecycle_state: 'active',
    expires_at: '2099-01-01T00:00:00.000Z',
    will_renew: true,
    grace_period_expires_at: null,
    updated_at: '2026-08-24T00:00:00.000Z',
  };
}

describe('WebEntitlementService identity boundary', () => {
  it('does not configure or purchase for anonymous identity', async () => {
    const rpc = vi.fn();
    const loadSdk = vi.fn();
    const service = new WebEntitlementService({
      apiKey: 'public-test-key',
      loadSdk: loadSdk as never,
      db: { rpc } as never,
    });

    const snapshot = await service.bindIdentity({ userId: '00000000-0000-4000-8000-000000000573', isAnonymous: true });
    expect(snapshot.tier).toBe('free');
    expect(loadSdk).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    const purchase = await service.purchase(PLUS_PRODUCT_IDS.monthly);
    expect(purchase.ok).toBe(false);
    if (!purchase.ok) expect(purchase.kind).toBe('anonymous');
  });

  it('clears the previous user before an account switch', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: row(firstUser), error: null })
      .mockResolvedValueOnce({ data: row(secondUser), error: null });
    const service = new WebEntitlementService({ apiKey: '', db: { rpc } as never });

    expect((await service.bindIdentity({ userId: firstUser, isAnonymous: false })).tier).toBe('plus');
    service.signOut();
    expect(service.snapshot.tier).toBe('free');
    expect((await service.bindIdentity({ userId: secondUser, isAnonymous: false })).productId).toBe(PLUS_PRODUCT_IDS.monthly);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the server response belongs to another user', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: row(secondUser), error: null });
    const service = new WebEntitlementService({ apiKey: '', db: { rpc } as never });
    const snapshot = await service.bindIdentity({ userId: firstUser, isAnonymous: false });
    expect(snapshot.tier).toBe('free');
    expect(snapshot.state).toBe('error');
  });

  it('returns a verified server Plus snapshot from restore instead of permanent pending', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: row(firstUser), error: null });
    const service = new WebEntitlementService({ apiKey: '', db: { rpc } as never });
    await service.bindIdentity({ userId: firstUser, isAnonymous: false });

    const restored = await service.restore();
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.snapshot.tier).toBe('plus');
  });

  it('keeps restore pending when the server has not reflected the purchase', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const service = new WebEntitlementService({ apiKey: '', db: { rpc } as never });
    await service.bindIdentity({ userId: firstUser, isAnonymous: false });

    const restored = await service.restore();
    expect(restored).toMatchObject({ ok: false, kind: 'pending' });
  });
});
