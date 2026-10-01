import { describe, expect, it } from 'vitest';

import {
  anonymousEntitlement,
  DEFAULT_OFFERING_ID,
  isPermanentUserId,
  PLUS_ENTITLEMENT_ID,
  PLUS_PRODUCT_IDS,
  resolveEntitlementSnapshot,
  signedOutEntitlement,
} from '@/lib/entitlements';

const userId = '00000000-0000-4000-8000-000000000571';
const activeRow = {
  user_id: userId,
  entitlement_id: PLUS_ENTITLEMENT_ID,
  offering_id: DEFAULT_OFFERING_ID,
  product_id: PLUS_PRODUCT_IDS.monthly,
  app_user_id: userId,
  store: 'TEST_STORE',
  environment: 'SANDBOX',
  is_active: true,
  lifecycle_state: 'active' as const,
  expires_at: '2026-08-25T00:00:00.000Z',
  will_renew: true,
  grace_period_expires_at: null,
  updated_at: '2026-08-24T00:00:00.000Z',
};

describe('Plus entitlement contract', () => {
  it('resolves only the exact plus/default/product contract', () => {
    expect(resolveEntitlementSnapshot(activeRow, Date.parse('2026-08-24T12:00:00Z'))).toMatchObject({
      tier: 'plus',
      state: 'plus',
      lifecycle: 'active',
      productId: PLUS_PRODUCT_IDS.monthly,
      offeringId: DEFAULT_OFFERING_ID,
    });
  });

  it.each([
    { ...activeRow, entitlement_id: 'pro' },
    { ...activeRow, offering_id: 'summer' },
    { ...activeRow, product_id: 'oisint_plus_pro' },
    { ...activeRow, is_active: false },
    { ...activeRow, expires_at: '2026-08-23T00:00:00.000Z' },
    { ...activeRow, expires_at: null },
    { ...activeRow, app_user_id: '00000000-0000-4000-8000-000000000572' },
  ])('fails closed to free for invalid or inactive state', (row) => {
    expect(resolveEntitlementSnapshot(row, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('free');
  });

  it('accepts grace only while the recorded grace window is future', () => {
    expect(resolveEntitlementSnapshot({
      ...activeRow,
      lifecycle_state: 'grace',
      expires_at: '2026-08-23T00:00:00.000Z',
      grace_period_expires_at: '2026-08-25T00:00:00.000Z',
    }, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('plus');
    expect(resolveEntitlementSnapshot({
      ...activeRow,
      lifecycle_state: 'grace',
      expires_at: '2026-08-23T00:00:00.000Z',
      grace_period_expires_at: '2026-08-24T00:00:00.000Z',
    }, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('free');
  });

  it('keeps a known billing issue active only until the recorded expiry', () => {
    expect(resolveEntitlementSnapshot({
      ...activeRow,
      lifecycle_state: 'billing_issue',
    }, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('plus');
    expect(resolveEntitlementSnapshot({
      ...activeRow,
      lifecycle_state: 'billing_issue',
      expires_at: null,
    }, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('free');
  });

  it('keeps a verified future grace window even when the subscription expiry is past', () => {
    expect(resolveEntitlementSnapshot({
      ...activeRow,
      lifecycle_state: 'billing_issue',
      expires_at: '2026-08-23T00:00:00.000Z',
      grace_period_expires_at: '2026-08-25T00:00:00.000Z',
    }, Date.parse('2026-08-24T12:00:00Z')).tier).toBe('plus');
  });

  it('never turns malformed payloads or missing identities into Plus', () => {
    expect(resolveEntitlementSnapshot({ ...activeRow, user_id: 'attacker' }).tier).toBe('free');
    expect(resolveEntitlementSnapshot(null).tier).toBe('free');
    expect(anonymousEntitlement().tier).toBe('free');
    expect(signedOutEntitlement().tier).toBe('free');
    expect(isPermanentUserId(userId)).toBe(true);
    expect(isPermanentUserId('anonymous-user')).toBe(false);
  });
});
