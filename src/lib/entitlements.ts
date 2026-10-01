import { z } from 'zod';

export const PLUS_ENTITLEMENT_ID = 'plus' as const;
export const DEFAULT_OFFERING_ID = 'default' as const;
export const PLUS_PRODUCT_IDS = {
  monthly: 'oisint_plus_monthly',
  annual: 'oisint_plus_annual',
} as const;

export type PlusProductId = (typeof PLUS_PRODUCT_IDS)[keyof typeof PLUS_PRODUCT_IDS];
export type EntitlementTier = 'free' | 'plus';
export type EntitlementLifecycle =
  | 'free'
  | 'active'
  | 'canceled'
  | 'grace'
  | 'billing_issue'
  | 'expired';
export type EntitlementState = 'loading' | 'free' | 'plus' | 'error';

export interface EntitlementSnapshot {
  tier: EntitlementTier;
  state: EntitlementState;
  lifecycle: EntitlementLifecycle;
  productId: PlusProductId | null;
  offeringId: typeof DEFAULT_OFFERING_ID;
  expiresAt: string | null;
  gracePeriodExpiresAt: string | null;
  willRenew: boolean;
  reason?: 'anonymous' | 'signed_out' | 'not_configured' | 'server_error' | 'invalid_payload';
}

export interface EntitlementOffering {
  productId: PlusProductId;
  packageId: string;
  title: string;
  price: string;
  period: string | null;
}

export type PurchaseResult =
  | { ok: true; snapshot: EntitlementSnapshot }
  | { ok: false; kind: 'anonymous' | 'not_configured' | 'cancelled' | 'failed' | 'pending'; message: string };

export const entitlementRowSchema = z.object({
  user_id: z.string().uuid(),
  entitlement_id: z.literal(PLUS_ENTITLEMENT_ID),
  offering_id: z.literal(DEFAULT_OFFERING_ID),
  product_id: z.enum([PLUS_PRODUCT_IDS.monthly, PLUS_PRODUCT_IDS.annual]).nullable(),
  app_user_id: z.string(),
  store: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  is_active: z.boolean(),
  lifecycle_state: z.enum(['free', 'active', 'canceled', 'grace', 'billing_issue', 'expired']),
  expires_at: z.string().nullable(),
  will_renew: z.boolean().nullable(),
  grace_period_expires_at: z.string().nullable(),
  updated_at: z.string().nullable().optional(),
}).strict();

export const freeSnapshot = (
  reason?: EntitlementSnapshot['reason'],
  state: EntitlementState = 'free',
): EntitlementSnapshot => ({
  tier: 'free',
  state,
  lifecycle: reason === 'server_error' || reason === 'invalid_payload' ? 'free' : reason === 'signed_out' || reason === 'anonymous' ? 'free' : 'free',
  productId: null,
  offeringId: DEFAULT_OFFERING_ID,
  expiresAt: null,
  gracePeriodExpiresAt: null,
  willRenew: false,
  ...(reason ? { reason } : {}),
});

export const signedOutEntitlement = (): EntitlementSnapshot => freeSnapshot('signed_out');
export const anonymousEntitlement = (): EntitlementSnapshot => freeSnapshot('anonymous');

function isFutureIso(value: string | null, nowMs: number): boolean {
  if (value === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs;
}

/** DB/RPC応答はuntrusted inputとして検証し、未知値はFreeへ倒す。 */
export function resolveEntitlementSnapshot(
  value: unknown,
  nowMs = Date.now(),
): EntitlementSnapshot {
  const parsed = entitlementRowSchema.safeParse(value);
  if (!parsed.success) return freeSnapshot('invalid_payload', 'error');
  const row = parsed.data;
  const activeWindow = isFutureIso(row.expires_at, nowMs) ||
    (row.grace_period_expires_at !== null && isFutureIso(row.grace_period_expires_at, nowMs));
  const lifecycleAllowsAccess = row.lifecycle_state === 'active' ||
    row.lifecycle_state === 'canceled' || row.lifecycle_state === 'grace' ||
    row.lifecycle_state === 'billing_issue';
  const canonicalSubject = row.app_user_id === row.user_id;
  const entitled = canonicalSubject && row.is_active && row.product_id !== null && lifecycleAllowsAccess && activeWindow;
  return {
    tier: entitled ? 'plus' : 'free',
    state: entitled ? 'plus' : 'free',
    lifecycle: row.lifecycle_state,
    productId: row.product_id,
    offeringId: DEFAULT_OFFERING_ID,
    expiresAt: row.expires_at,
    gracePeriodExpiresAt: row.grace_period_expires_at,
    willRenew: row.will_renew === true,
  };
}

export function isPermanentUserId(value: string | null | undefined): value is string {
  return typeof value === 'string' && z.string().uuid().safeParse(value).success;
}

export function productIdFromPackage(value: string | null | undefined): PlusProductId | null {
  return value === PLUS_PRODUCT_IDS.monthly || value === PLUS_PRODUCT_IDS.annual ? value : null;
}
