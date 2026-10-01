// Crawl queue の実行基盤非依存契約 (#117)
//
// Supabase 実装は service-role RPC の adapter、fixture は同じ契約の in-memory
// 実装を使う。worker はどちらにも依存せず、enqueue/lease/complete/fail の状態遷移
// と冪等性をこの interface だけで扱う。
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RobotsPolicyCache,
  RobotsPolicyCacheRecord,
} from "./providers/fetcher.ts";
import {
  CRAWL_MAX_ATTEMPTS,
  CRAWL_ORIGIN_FAILURE_THRESHOLD,
  type CrawlBudgetSnapshot,
  type CrawlErrorCode,
  failureDisposition,
  retryBackoffMs,
} from "./crawler.ts";

export type CrawlPurpose = "discover" | "refresh";
export type CrawlQueueStatus =
  | "pending"
  | "in_flight"
  | "done"
  | "failed"
  | "dead";

export interface CrawlQueueEnqueueInput {
  idempotencyKey: string;
  jobId: string;
  canonicalUrl: string;
  origin: string;
  purpose: CrawlPurpose;
  depth: number;
  placeId: string | null;
  scheduleWindow: string;
  enqueuedBy: string;
  queryPathKey: string;
  queryVariantKey: string;
  budgetSnapshot: CrawlBudgetSnapshot;
}

export interface CrawlQueueItem {
  id: string;
  idempotencyKey: string;
  jobId: string;
  canonicalUrl: string;
  origin: string;
  purpose: CrawlPurpose;
  depth: number;
  placeId: string | null;
  scheduleWindow: string;
  enqueuedBy: string;
  queryPathKey: string;
  queryVariantKey: string;
  budgetSnapshot: CrawlBudgetSnapshot;
  status: CrawlQueueStatus;
  attempt: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: CrawlErrorCode | null;
  contentHash: string | null;
  responseBytes: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CrawlQueueEnqueueResult {
  inserted: boolean;
  item: CrawlQueueItem;
}

export interface CrawlQueueCompleteResult {
  completed: boolean;
  duplicateContent: boolean;
  budgetExceeded: boolean;
}

export interface CrawlQueueFailureResult {
  status: CrawlQueueStatus;
  retryAt: string | null;
  originCircuitOpen: boolean;
  deadCount: number;
}

export interface CrawlQueueStore {
  enqueue(input: CrawlQueueEnqueueInput): Promise<CrawlQueueEnqueueResult>;
  lease(
    workerId: string,
    leaseSeconds?: number,
  ): Promise<CrawlQueueItem | null>;
  renew(item: CrawlQueueItem, leaseSeconds?: number): Promise<boolean>;
  complete(
    item: CrawlQueueItem,
    contentHash: string,
    responseBytes: number,
  ): Promise<CrawlQueueCompleteResult>;
  fail(
    item: CrawlQueueItem,
    errorCode: CrawlErrorCode,
    retryable: boolean,
  ): Promise<CrawlQueueFailureResult>;
  markDead(item: CrawlQueueItem, errorCode: CrawlErrorCode): Promise<boolean>;
  recordOriginPolicy(
    origin: string,
    crawlDelaySeconds: number | null,
  ): Promise<void>;
}

export class CrawlQueueError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`crawl queue ${operation} failed`);
    this.name = "CrawlQueueError";
    this.operation = operation;
  }
}

/** robots.txt の本文を保存せず、解析済みpolicyだけを24時間参照するadapter。 */
export class SupabaseRobotsPolicyCache implements RobotsPolicyCache {
  constructor(private readonly db: SupabaseClient) {}

  async get(origin: string): Promise<RobotsPolicyCacheRecord | null> {
    const { data, error } = await this.db
      .from("crawl_robots_cache")
      .select("fetched_at, expires_at, available, rules, crawl_delay_seconds")
      .eq("origin", origin)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    const fetchedAt = row.fetched_at;
    const expiresAt = row.expires_at;
    const available = row.available;
    const rules = row.rules;
    const delay = row.crawl_delay_seconds;
    if (
      typeof fetchedAt !== "string" || typeof available !== "boolean" ||
      typeof expiresAt !== "string" || Date.parse(expiresAt) <= Date.now() ||
      !Array.isArray(rules) ||
      rules.some((rule) =>
        !rule || typeof rule !== "object" || Array.isArray(rule) ||
        typeof (rule as Record<string, unknown>).allow !== "boolean" ||
        typeof (rule as Record<string, unknown>).pattern !== "string"
      ) ||
      (delay !== null && delay !== undefined &&
        (typeof delay !== "number" || !Number.isFinite(delay)))
    ) return null;
    return {
      fetchedAt,
      available,
      rules: rules as RobotsPolicyCacheRecord["rules"],
      crawlDelaySeconds: delay === null || delay === undefined ? null : delay,
    };
  }

  async set(origin: string, record: RobotsPolicyCacheRecord): Promise<void> {
    const { error } = await this.db.from("crawl_robots_cache").upsert({
      origin,
      fetched_at: record.fetchedAt,
      expires_at: new Date(Date.parse(record.fetchedAt) + 24 * 60 * 60 * 1_000)
        .toISOString(),
      available: record.available,
      rules: record.rules,
      crawl_delay_seconds: record.crawlDelaySeconds,
    });
    if (error) throw new CrawlQueueError("robots cache");
  }
}

function firstRpcRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return first && typeof first === "object" && !Array.isArray(first)
      ? first as Record<string, unknown>
      : null;
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CrawlQueueError(`invalid ${key}`);
  }
  return value;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new CrawlQueueError(`invalid ${key}`);
  return value;
}

function nullableString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CrawlQueueError(`invalid ${key}`);
  return value;
}

function integerValue(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CrawlQueueError(`invalid ${key}`);
  }
  return value;
}

function booleanValue(row: Record<string, unknown>, key: string): boolean {
  if (typeof row[key] !== "boolean") {
    throw new CrawlQueueError(`invalid ${key}`);
  }
  return row[key] as boolean;
}

const CRAWL_ERROR_CODES: ReadonlySet<string> = new Set([
  "no_gateway",
  "bad_url",
  "denylisted",
  "non_public_address",
  "dns_failed",
  "blocked_or_empty",
  "robots_unavailable",
  "robots_denied",
  "redirect_loop",
  "redirect_rejected",
  "network_error",
  "timeout",
  "http_error",
  "auth_required",
  "non_html",
  "body_too_large",
  "mime_mismatch",
  "robots_meta_denied",
  "empty_body",
  "aborted",
  "budget_exceeded",
  "duplicate_content",
  "origin_circuit_open",
  "lease_lost",
  "attempt_limit",
  "invalid_url",
]);

function jsonObjectValue(
  row: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = row[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CrawlQueueError(`invalid ${key}`);
  }
  return value as Record<string, unknown>;
}

function budgetSnapshotValue(
  row: Record<string, unknown>,
): CrawlBudgetSnapshot {
  const value = jsonObjectValue(row, "budget_snapshot");
  const policyVersion = value.policy_version ?? value.policyVersion;
  const remainingPagesTotal = value.remaining_pages_total ??
    value.remainingPagesTotal;
  const remainingBytesTotal = value.remaining_bytes_total ??
    value.remainingBytesTotal;
  const remainingPagesForOrigin = value.remaining_pages_for_origin ??
    value.remainingPagesForOrigin;
  const remainingQueryVariantsForPath =
    value.remaining_query_variants_for_path ??
      value.remainingQueryVariantsForPath;
  if (
    policyVersion !== "safe-crawl-v1" ||
    ![
      remainingPagesTotal,
      remainingBytesTotal,
      remainingPagesForOrigin,
      remainingQueryVariantsForPath,
    ].every((value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    )
  ) throw new CrawlQueueError("invalid budget_snapshot");
  return {
    policyVersion: "safe-crawl-v1",
    remainingPagesTotal: remainingPagesTotal as number,
    remainingBytesTotal: remainingBytesTotal as number,
    remainingPagesForOrigin: remainingPagesForOrigin as number,
    remainingQueryVariantsForPath: remainingQueryVariantsForPath as number,
  };
}

function queueItemFromRow(row: Record<string, unknown>): CrawlQueueItem {
  const purpose = requiredString(row, "purpose");
  const status = requiredString(row, "status");
  if (purpose !== "discover" && purpose !== "refresh") {
    throw new CrawlQueueError("invalid purpose");
  }
  if (
    !(["pending", "in_flight", "done", "failed", "dead"] as string[]).includes(
      status,
    )
  ) {
    throw new CrawlQueueError("invalid status");
  }
  const attempt = integerValue(row, "attempt");
  if (attempt < 0 || attempt > CRAWL_MAX_ATTEMPTS) {
    throw new CrawlQueueError("invalid attempt");
  }
  const depth = integerValue(row, "depth");
  if (depth < 0 || depth > 2) throw new CrawlQueueError("invalid depth");
  const lastErrorCode = nullableString(row, "last_error_code");
  if (lastErrorCode !== null && !CRAWL_ERROR_CODES.has(lastErrorCode)) {
    throw new CrawlQueueError("invalid last_error_code");
  }
  const contentHash = nullableString(row, "content_hash");
  if (contentHash !== null && !/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new CrawlQueueError("invalid content_hash");
  }
  const responseBytes =
    row.response_bytes === null || row.response_bytes === undefined
      ? null
      : integerValue(row, "response_bytes");
  if (
    responseBytes !== null && (responseBytes < 0 || responseBytes > 500_000)
  ) {
    throw new CrawlQueueError("invalid response_bytes");
  }
  return {
    id: requiredString(row, "queue_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    jobId: requiredString(row, "job_id"),
    canonicalUrl: requiredString(row, "canonical_url"),
    origin: requiredString(row, "origin"),
    purpose,
    depth,
    placeId: nullableString(row, "place_id"),
    scheduleWindow: requiredString(row, "schedule_window"),
    enqueuedBy: requiredString(row, "enqueued_by"),
    queryPathKey: requiredString(row, "query_path_key"),
    queryVariantKey: stringValue(row, "query_variant_key"),
    budgetSnapshot: budgetSnapshotValue(row),
    status: status as CrawlQueueStatus,
    attempt,
    nextAttemptAt: requiredString(row, "next_attempt_at"),
    leaseOwner: nullableString(row, "lease_owner"),
    leaseExpiresAt: nullableString(row, "lease_expires_at"),
    lastErrorCode: lastErrorCode as CrawlErrorCode | null,
    contentHash,
    responseBytes,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    completedAt: nullableString(row, "completed_at"),
  };
}

/** PostgreSQL/RPC adapter。queue tableをData APIへ直接公開せず、RPCだけを使う。 */
export class SupabaseCrawlQueue implements CrawlQueueStore {
  constructor(private readonly db: SupabaseClient) {}

  async enqueue(
    input: CrawlQueueEnqueueInput,
  ): Promise<CrawlQueueEnqueueResult> {
    const { data, error } = await this.db.rpc("enqueue_crawl_queue_item", {
      p_job_id: input.jobId,
      p_idempotency_key: input.idempotencyKey,
      p_canonical_url: input.canonicalUrl,
      p_origin: input.origin,
      p_purpose: input.purpose,
      p_depth: input.depth,
      p_place_id: input.placeId,
      p_schedule_window: input.scheduleWindow,
      p_enqueued_by: input.enqueuedBy,
      p_query_path_key: input.queryPathKey,
      p_query_variant_key: input.queryVariantKey,
      p_budget_snapshot: input.budgetSnapshot,
    });
    if (error) throw new CrawlQueueError("enqueue");
    const row = firstRpcRow(data);
    if (!row) throw new CrawlQueueError("enqueue response");
    return {
      inserted: booleanValue(row, "inserted"),
      item: queueItemFromRow(row),
    };
  }

  async lease(
    workerId: string,
    leaseSeconds = 60,
  ): Promise<CrawlQueueItem | null> {
    const { data, error } = await this.db.rpc("lease_crawl_queue_item", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new CrawlQueueError("lease");
    const row = firstRpcRow(data);
    return row ? queueItemFromRow(row) : null;
  }

  async renew(item: CrawlQueueItem, leaseSeconds = 60): Promise<boolean> {
    const { data, error } = await this.db.rpc("renew_crawl_queue_lease", {
      p_queue_id: item.id,
      p_lease_owner: item.leaseOwner,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new CrawlQueueError("renew");
    const row = firstRpcRow(data);
    return row ? booleanValue(row, "renewed") : false;
  }

  async complete(
    item: CrawlQueueItem,
    contentHash: string,
    responseBytes: number,
  ): Promise<CrawlQueueCompleteResult> {
    const { data, error } = await this.db.rpc("complete_crawl_queue_item", {
      p_queue_id: item.id,
      p_lease_owner: item.leaseOwner,
      p_content_hash: contentHash,
      p_response_bytes: responseBytes,
    });
    if (error) throw new CrawlQueueError("complete");
    const row = firstRpcRow(data);
    if (!row) throw new CrawlQueueError("complete response");
    return {
      completed: booleanValue(row, "completed"),
      duplicateContent: booleanValue(row, "duplicate_content"),
      budgetExceeded: booleanValue(row, "budget_exceeded"),
    };
  }

  async fail(
    item: CrawlQueueItem,
    errorCode: CrawlErrorCode,
    retryable: boolean,
  ): Promise<CrawlQueueFailureResult> {
    const { data, error } = await this.db.rpc("fail_crawl_queue_item", {
      p_queue_id: item.id,
      p_lease_owner: item.leaseOwner,
      p_error_code: errorCode,
      p_retryable: retryable,
    });
    if (error) throw new CrawlQueueError("fail");
    const row = firstRpcRow(data);
    if (!row) throw new CrawlQueueError("fail response");
    return {
      status: requiredString(row, "status") as CrawlQueueStatus,
      retryAt: nullableString(row, "retry_at"),
      originCircuitOpen: booleanValue(row, "origin_circuit_open"),
      deadCount: integerValue(row, "dead_count"),
    };
  }

  async markDead(
    item: CrawlQueueItem,
    errorCode: CrawlErrorCode,
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("mark_crawl_queue_dead", {
      p_queue_id: item.id,
      p_lease_owner: item.leaseOwner,
      p_error_code: errorCode,
    });
    if (error) throw new CrawlQueueError("dead");
    const row = firstRpcRow(data);
    return row ? booleanValue(row, "marked") : false;
  }

  async recordOriginPolicy(
    origin: string,
    crawlDelaySeconds: number | null,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_crawl_origin_policy", {
      p_origin: origin,
      p_crawl_delay_seconds: crawlDelaySeconds,
    });
    if (error) throw new CrawlQueueError("origin policy");
  }
}

interface InMemoryOriginState {
  inFlight: boolean;
  nextAllowedAt: number;
  crawlDelaySeconds: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
}

function copyItem(item: CrawlQueueItem): CrawlQueueItem {
  return { ...item, budgetSnapshot: { ...item.budgetSnapshot } };
}

/** 外部fetchなしのfixture用。Supabase RPCと同じ状態遷移・冪等性を再現する。 */
export class InMemoryCrawlQueue implements CrawlQueueStore {
  private readonly itemsById = new Map<string, CrawlQueueItem>();
  private readonly idsByKey = new Map<string, string>();
  private readonly origins = new Map<string, InMemoryOriginState>();
  private clock: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.clock = now;
  }

  setClock(now: () => number): void {
    this.clock = now;
  }

  private now(): number {
    return this.clock();
  }

  private originState(origin: string): InMemoryOriginState {
    const existing = this.origins.get(origin);
    if (existing) return existing;
    const created: InMemoryOriginState = {
      inFlight: false,
      nextAllowedAt: 0,
      crawlDelaySeconds: 10,
      consecutiveFailures: 0,
      circuitOpen: false,
    };
    this.origins.set(origin, created);
    return created;
  }

  async enqueue(
    input: CrawlQueueEnqueueInput,
  ): Promise<CrawlQueueEnqueueResult> {
    await Promise.resolve();
    const existingId = this.idsByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.itemsById.get(existingId);
      if (!existing) throw new CrawlQueueError("idempotency index");
      return { inserted: false, item: copyItem(existing) };
    }
    const activeCanonical = [...this.itemsById.values()].find((item) =>
      item.canonicalUrl === input.canonicalUrl &&
      (item.status === "pending" || item.status === "in_flight")
    );
    if (activeCanonical) {
      // A URL is deduplicated across schedule windows while work is active;
      // terminal rows remain history and can be refreshed in a later window.
      return { inserted: false, item: copyItem(activeCanonical) };
    }
    const now = new Date(this.now()).toISOString();
    const item: CrawlQueueItem = {
      id: crypto.randomUUID(),
      ...input,
      status: "pending",
      attempt: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      contentHash: null,
      responseBytes: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.itemsById.set(item.id, item);
    this.idsByKey.set(item.idempotencyKey, item.id);
    this.originState(item.origin);
    return { inserted: true, item: copyItem(item) };
  }

  private releaseExpiredLeases(now: number): void {
    for (const item of this.itemsById.values()) {
      if (
        item.status === "in_flight" && item.leaseExpiresAt &&
        new Date(item.leaseExpiresAt).getTime() <= now
      ) {
        item.status = "pending";
        item.leaseOwner = null;
        item.leaseExpiresAt = null;
        item.updatedAt = new Date(now).toISOString();
        this.originState(item.origin).inFlight = false;
      }
    }
  }

  async lease(
    workerId: string,
    leaseSeconds = 60,
  ): Promise<CrawlQueueItem | null> {
    await Promise.resolve();
    if (
      !workerId || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 ||
      leaseSeconds > 600
    ) {
      throw new CrawlQueueError("invalid lease");
    }
    const now = this.now();
    this.releaseExpiredLeases(now);
    const pending = [...this.itemsById.values()]
      .filter((item) =>
        item.status === "pending" &&
        new Date(item.nextAttemptAt).getTime() <= now
      )
      .sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
    for (const item of pending) {
      const origin = this.originState(item.origin);
      if (origin.circuitOpen || origin.inFlight || origin.nextAllowedAt > now) {
        continue;
      }
      if (item.attempt >= CRAWL_MAX_ATTEMPTS) {
        item.status = "dead";
        item.lastErrorCode = "attempt_limit";
        item.updatedAt = new Date(now).toISOString();
        continue;
      }
      item.status = "in_flight";
      item.attempt += 1;
      item.leaseOwner = workerId;
      item.leaseExpiresAt = new Date(now + leaseSeconds * 1_000).toISOString();
      item.updatedAt = new Date(now).toISOString();
      origin.inFlight = true;
      origin.nextAllowedAt = now +
        Math.max(10, origin.crawlDelaySeconds) * 1_000;
      return copyItem(item);
    }
    return null;
  }

  async renew(item: CrawlQueueItem, leaseSeconds = 60): Promise<boolean> {
    await Promise.resolve();
    const current = this.itemsById.get(item.id);
    const now = this.now();
    if (
      !current || current.status !== "in_flight" ||
      current.leaseOwner !== item.leaseOwner || !current.leaseOwner ||
      !current.leaseExpiresAt ||
      new Date(current.leaseExpiresAt).getTime() <= now ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 ||
      leaseSeconds > 600
    ) return false;
    current.leaseExpiresAt = new Date(now + leaseSeconds * 1_000).toISOString();
    current.updatedAt = new Date(now).toISOString();
    return true;
  }

  async complete(
    item: CrawlQueueItem,
    contentHash: string,
    responseBytes: number,
  ): Promise<CrawlQueueCompleteResult> {
    await Promise.resolve();
    if (
      !/^[0-9a-f]{64}$/.test(contentHash) ||
      !Number.isSafeInteger(responseBytes) || responseBytes < 0 ||
      responseBytes > 500_000
    ) {
      throw new CrawlQueueError("invalid completion");
    }
    const current = this.itemsById.get(item.id);
    const now = this.now();
    if (current?.status === "done") {
      return {
        completed: true,
        duplicateContent: current.lastErrorCode === "duplicate_content",
        budgetExceeded: current.lastErrorCode === "budget_exceeded",
      };
    }
    if (
      !current || current.status !== "in_flight" ||
      current.leaseOwner !== item.leaseOwner || !current.leaseOwner ||
      !current.leaseExpiresAt ||
      new Date(current.leaseExpiresAt).getTime() <= now
    ) {
      return {
        completed: false,
        duplicateContent: false,
        budgetExceeded: false,
      };
    }

    const duplicateContent = [...this.itemsById.values()].some((other) =>
      other.id !== current.id && other.status === "done" &&
      other.contentHash === contentHash
    );
    current.status = "done";
    current.lastErrorCode = duplicateContent ? "duplicate_content" : null;
    current.contentHash = contentHash;
    current.responseBytes = responseBytes;
    current.leaseOwner = null;
    current.leaseExpiresAt = null;
    current.completedAt = new Date(now).toISOString();
    current.updatedAt = new Date(now).toISOString();
    const origin = this.originState(current.origin);
    origin.inFlight = false;
    origin.consecutiveFailures = 0;
    return { completed: true, duplicateContent, budgetExceeded: false };
  }

  async fail(
    item: CrawlQueueItem,
    errorCode: CrawlErrorCode,
    retryable: boolean,
  ): Promise<CrawlQueueFailureResult> {
    await Promise.resolve();
    const current = this.itemsById.get(item.id);
    const now = this.now();
    if (!current) throw new CrawlQueueError("unknown item");
    if (current.status === "failed" || current.status === "dead") {
      return {
        status: current.status,
        retryAt: null,
        originCircuitOpen: this.originState(current.origin).circuitOpen,
        deadCount: 0,
      };
    }
    if (
      current.status !== "in_flight" ||
      current.leaseOwner !== item.leaseOwner ||
      !current.leaseOwner || !current.leaseExpiresAt ||
      new Date(current.leaseExpiresAt).getTime() <= now
    ) {
      return {
        status: current.status,
        retryAt: null,
        originCircuitOpen: this.originState(current.origin).circuitOpen,
        deadCount: 0,
      };
    }
    const disposition = failureDisposition(errorCode, current.attempt);
    const origin = this.originState(current.origin);
    current.lastErrorCode = errorCode;
    current.leaseOwner = null;
    current.leaseExpiresAt = null;
    current.updatedAt = new Date(now).toISOString();
    origin.inFlight = false;
    if (retryable && disposition === "pending") {
      current.status = "pending";
      current.nextAttemptAt = new Date(
        now + retryBackoffMs(current.attempt, 0.5),
      ).toISOString();
    } else if (retryable && disposition === "dead") {
      current.status = "dead";
    } else {
      current.status = "failed";
      origin.consecutiveFailures += 1;
    }

    let deadCount = current.status === "dead" ? 1 : 0;
    if (origin.consecutiveFailures >= CRAWL_ORIGIN_FAILURE_THRESHOLD) {
      origin.circuitOpen = true;
      for (const other of this.itemsById.values()) {
        if (other.origin === current.origin && other.status === "pending") {
          other.status = "dead";
          other.lastErrorCode = "origin_circuit_open";
          other.updatedAt = new Date(now).toISOString();
          deadCount += 1;
        }
      }
    }
    return {
      status: current.status,
      retryAt: current.status === "pending" ? current.nextAttemptAt : null,
      originCircuitOpen: origin.circuitOpen,
      deadCount,
    };
  }

  async markDead(
    item: CrawlQueueItem,
    errorCode: CrawlErrorCode,
  ): Promise<boolean> {
    await Promise.resolve();
    const current = this.itemsById.get(item.id);
    if (!current || current.status === "done" || current.status === "dead") {
      return false;
    }
    if (
      current.status === "in_flight" &&
      (current.leaseOwner !== item.leaseOwner || !current.leaseOwner ||
        !current.leaseExpiresAt ||
        new Date(current.leaseExpiresAt).getTime() <= this.now())
    ) return false;
    current.status = "dead";
    current.lastErrorCode = errorCode;
    current.leaseOwner = null;
    current.leaseExpiresAt = null;
    current.updatedAt = new Date(this.now()).toISOString();
    this.originState(current.origin).inFlight = false;
    return true;
  }

  async recordOriginPolicy(
    origin: string,
    crawlDelaySeconds: number | null,
  ): Promise<void> {
    await Promise.resolve();
    const state = this.originState(origin);
    if (
      crawlDelaySeconds !== null && Number.isFinite(crawlDelaySeconds) &&
      crawlDelaySeconds > 0
    ) {
      const effectiveDelay = Math.max(
        10,
        Math.min(86_400, crawlDelaySeconds),
      );
      state.crawlDelaySeconds = Math.max(
        state.crawlDelaySeconds,
        effectiveDelay,
      );
      state.nextAllowedAt = Math.max(
        state.nextAllowedAt,
        this.now() + state.crawlDelaySeconds * 1_000,
      );
    }
  }

  list(): CrawlQueueItem[] {
    return [...this.itemsById.values()].map(copyItem);
  }

  originSnapshot(origin: string): Readonly<InMemoryOriginState> {
    return { ...this.originState(origin) };
  }
}
