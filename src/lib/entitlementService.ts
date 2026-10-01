import type {
  CustomerInfo,
  Purchases,
} from '@revenuecat/purchases-js';
import { supabase } from '@/lib/supabase';
import {
  anonymousEntitlement,
  DEFAULT_OFFERING_ID,
  entitlementRowSchema,
  freeSnapshot,
  isPermanentUserId,
  PLUS_ENTITLEMENT_ID,
  productIdFromPackage,
  resolveEntitlementSnapshot,
  signedOutEntitlement,
  type EntitlementOffering,
  type EntitlementSnapshot,
  type PlusProductId,
  type PurchaseResult,
} from '@/lib/entitlements';

type RevenueCatModule = typeof import('@revenuecat/purchases-js');
type PurchasesClient = InstanceType<typeof Purchases>;

export interface EntitlementIdentity {
  userId: string | null;
  isAnonymous: boolean;
}

export interface EntitlementService {
  readonly snapshot: EntitlementSnapshot;
  bindIdentity(identity: EntitlementIdentity): Promise<EntitlementSnapshot>;
  refresh(): Promise<EntitlementSnapshot>;
  offerings(): Promise<EntitlementOffering[]>;
  purchase(productId: PlusProductId): Promise<PurchaseResult>;
  restore(): Promise<PurchaseResult>;
  signOut(): void;
}

function oneRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function infoSnapshot(info: CustomerInfo, current: EntitlementSnapshot): EntitlementSnapshot {
  const plus = info.entitlements.all[PLUS_ENTITLEMENT_ID];
  const expirationDate = plus?.expirationDate ?? null;
  const gracePeriodExpiresDate = plus && 'gracePeriodExpiresDate' in plus
    ? ((plus as { gracePeriodExpiresDate?: Date | null }).gracePeriodExpiresDate ?? null)
    : null;
  const nowMs = Date.now();
  const hasFutureExpiration = expirationDate !== null &&
    Number.isFinite(expirationDate.getTime()) &&
    expirationDate.getTime() > nowMs;
  const hasFutureGrace = gracePeriodExpiresDate !== null &&
    Number.isFinite(gracePeriodExpiresDate.getTime()) &&
    gracePeriodExpiresDate.getTime() > nowMs;
  if (
    !plus ||
    !plus.isActive ||
    !productIdFromPackage(plus.productIdentifier) ||
    (!hasFutureExpiration && !hasFutureGrace)
  ) {
    return current.tier === 'plus' ? current : freeSnapshot();
  }
  return {
    tier: 'plus',
    state: 'plus',
    lifecycle: plus.willRenew ? 'active' : 'canceled',
    productId: productIdFromPackage(plus.productIdentifier),
    offeringId: DEFAULT_OFFERING_ID,
    expiresAt: hasFutureExpiration ? expirationDate!.toISOString() : null,
    gracePeriodExpiresAt: hasFutureGrace ? gracePeriodExpiresDate!.toISOString() : null,
    willRenew: plus.willRenew,
  };
}

function sdkErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errorCode' in error)) return null;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === 'number' ? code : null;
}

/**
 * Web Billing SDKをこのサービスへ閉じ込める。UI/画面はSupabaseのserver entitlementを正本とし、
 * SDK customer infoは購入結果の補助表示にだけ使う。
 */
export class WebEntitlementService implements EntitlementService {
  private currentSnapshot: EntitlementSnapshot = signedOutEntitlement();
  private currentUserId: string | null = null;
  private purchases: PurchasesClient | null = null;
  private identityGeneration = 0;
  private readonly apiKey: string;
  private readonly loadSdk: () => Promise<RevenueCatModule>;
  private readonly db: typeof supabase;

  constructor(options: {
    apiKey?: string;
    loadSdk?: () => Promise<RevenueCatModule>;
    db?: typeof supabase;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.EXPO_PUBLIC_REVENUECAT_WEB_PUBLIC_KEY ?? '';
    this.loadSdk = options.loadSdk ?? (() => import('@revenuecat/purchases-js'));
    this.db = options.db ?? supabase;
  }

  get snapshot(): EntitlementSnapshot {
    return this.currentSnapshot;
  }

  async bindIdentity(identity: EntitlementIdentity): Promise<EntitlementSnapshot> {
    const generation = ++this.identityGeneration;
    // identityが変わる瞬間は必ずFreeへ戻し、前利用者のPlusを表示しない。
    this.currentUserId = null;
    this.currentSnapshot = identity.isAnonymous
      ? anonymousEntitlement()
      : identity.userId
      ? freeSnapshot('server_error', 'loading')
      : signedOutEntitlement();
    if (identity.isAnonymous || !isPermanentUserId(identity.userId)) return this.currentSnapshot;

    this.currentUserId = identity.userId;
    if (this.apiKey) {
      try {
        const sdk = await this.loadSdk();
        if (!sdk.Purchases.isConfigured()) {
          this.purchases = sdk.Purchases.configure({ apiKey: this.apiKey, appUserId: identity.userId });
        } else {
          this.purchases = sdk.Purchases.getSharedInstance();
          if (this.purchases.getAppUserId() !== identity.userId) {
            // purchases-jsはmobileのlogIn/logOutではなくchangeUserで恒久IDを切り替える。
            await this.purchases.changeUser(identity.userId);
          }
        }
      } catch {
        this.purchases = null;
        this.currentSnapshot = freeSnapshot('not_configured', 'error');
      }
    }
    if (generation !== this.identityGeneration) return this.currentSnapshot;
    return this.refreshForGeneration(generation);
  }

  async refresh(): Promise<EntitlementSnapshot> {
    return this.refreshForGeneration(this.identityGeneration);
  }

  private async refreshForGeneration(generation: number): Promise<EntitlementSnapshot> {
    if (!this.currentUserId) return this.currentSnapshot;
    const userId = this.currentUserId;
    try {
      const { data, error } = await this.db.rpc('get_my_entitlement');
      if (error) throw error;
      const row = oneRow(data);
      if (generation !== this.identityGeneration || this.currentUserId !== userId) {
        return this.currentSnapshot;
      }
      if (row === null) {
        this.currentSnapshot = freeSnapshot();
      } else {
        const checked = entitlementRowSchema.safeParse(row);
        if (
          !checked.success ||
          checked.data.user_id !== userId ||
          checked.data.app_user_id !== userId
        ) {
          this.currentSnapshot = freeSnapshot('invalid_payload', 'error');
        } else {
          this.currentSnapshot = resolveEntitlementSnapshot(row);
        }
      }
    } catch {
      if (generation === this.identityGeneration && this.currentUserId === userId) {
        this.currentSnapshot = freeSnapshot('server_error', 'error');
      }
    }
    return this.currentSnapshot;
  }

  async offerings(): Promise<EntitlementOffering[]> {
    if (!this.currentUserId || !this.purchases) return [];
    const generation = this.identityGeneration;
    const userId = this.currentUserId;
    const offerings = await this.purchases.getOfferings({ offeringIdentifier: DEFAULT_OFFERING_ID });
    if (generation !== this.identityGeneration || this.currentUserId !== userId) return [];
    const offering = offerings.current?.identifier === DEFAULT_OFFERING_ID
      ? offerings.current
      : offerings.all[DEFAULT_OFFERING_ID];
    if (!offering) return [];
    return offering.availablePackages.flatMap((pkg) => {
      const productId = productIdFromPackage(pkg.webBillingProduct.identifier);
      if (!productId) return [];
      return [{
        productId,
        packageId: pkg.identifier,
        title: pkg.webBillingProduct.title,
        price: pkg.webBillingProduct.price.formattedPrice,
        period: pkg.webBillingProduct.period?.unit ?? null,
      }];
    });
  }

  async purchase(productId: PlusProductId): Promise<PurchaseResult> {
    if (!this.currentUserId) return { ok: false, kind: 'anonymous', message: '購入には恒久アカウントへのログインが必要です。' };
    const generation = this.identityGeneration;
    const userId = this.currentUserId;
    if (!this.purchases) return { ok: false, kind: 'not_configured', message: '購入機能は現在設定されていません。' };
    const offerings = await this.purchases.getOfferings({ offeringIdentifier: DEFAULT_OFFERING_ID });
    if (generation !== this.identityGeneration || this.currentUserId !== userId) {
      return { ok: false, kind: 'failed', message: 'アカウントが切り替わったため購入状態を表示できません。' };
    }
    const offering = offerings.current?.identifier === DEFAULT_OFFERING_ID
      ? offerings.current
      : offerings.all[DEFAULT_OFFERING_ID];
    const pkg = offering?.availablePackages.find((item) => item.webBillingProduct.identifier === productId);
    if (!pkg) return { ok: false, kind: 'failed', message: 'このプランは現在購入できません。' };
    try {
      const result = await this.purchases.purchase({ rcPackage: pkg });
      if (generation !== this.identityGeneration || this.currentUserId !== userId) {
        return { ok: false, kind: 'failed', message: 'アカウントが切り替わったため購入状態を表示できません。' };
      }
      const local = infoSnapshot(result.customerInfo, this.currentSnapshot);
      const server = await this.refreshForGeneration(generation);
      return server.tier === 'plus'
        ? { ok: true, snapshot: server }
        : { ok: false, kind: 'pending', message: local.tier === 'plus' ? '購入を受け付けました。反映まで少しお待ちください。' : '購入結果を確認できませんでした。時間をおいて再確認してください。' };
    } catch (error) {
      if (sdkErrorCode(error) === 1) return { ok: false, kind: 'cancelled', message: '購入をキャンセルしました。' };
      return { ok: false, kind: 'failed', message: '購入を完了できませんでした。請求状態を確認してください。' };
    }
  }

  async restore(): Promise<PurchaseResult> {
    if (!this.currentUserId) return { ok: false, kind: 'anonymous', message: '復元には恒久アカウントへのログインが必要です。' };
    const generation = this.identityGeneration;
    // Web Billingにはmobileストアのrestore APIがない。server webhookによる自動同期を正直に表示する。
    const server = await this.refreshForGeneration(generation);
    if (server.tier === 'plus') return { ok: true, snapshot: server };
    return { ok: false, kind: 'pending', message: 'Webでは購入情報が自動同期されます。反映されない場合は時間をおいて再確認してください。' };
  }

  signOut(): void {
    this.identityGeneration += 1;
    this.currentUserId = null;
    this.purchases = null;
    this.currentSnapshot = signedOutEntitlement();
  }
}
