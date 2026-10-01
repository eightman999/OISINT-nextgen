import type {
  RevenueCatCustomerDeletionResult,
} from "../_shared/revenuecat_customer.ts";

/**
 * The orchestration layer deliberately knows only bounded step results.  It
 * never receives a provider response body, secret, or database error object,
 * so callers cannot accidentally expose those values in a response or log.
 */
export type AccountDeletionStepResult =
  | { ok: true }
  | { ok: false; code?: string };

export type RevenueCatDeletionRecordStatus =
  | "succeeded"
  | "failed"
  | "local_cleanup_failed";

export type AccountDeletionOutcome =
  | { ok: true }
  | {
    ok: false;
    stage:
      | "external_record"
      | "external"
      | "purge"
      | "finalize"
      | "auth";
    code?: string;
    reason?: string;
  };

export interface AccountDeletionOrchestrationDeps {
  /** Whether this subject has a permanent RevenueCat customer to erase. */
  deleteExternalCustomer: boolean;
  /** Whether the canonical outbox must be finalized for this subject. */
  hasExternalOutbox: boolean;
  deleteRevenueCatCustomer: () => Promise<RevenueCatCustomerDeletionResult>;
  recordRevenueCatDeletion: (
    status: RevenueCatDeletionRecordStatus,
    errorCode: string | null,
  ) => Promise<boolean>;
  purgeLocalData: () => Promise<AccountDeletionStepResult>;
  finalizeRevenueCatDeletion: () => Promise<boolean>;
  deleteAuthUser: () => Promise<AccountDeletionStepResult>;
}

const SAFE_REVENUECAT_REASONS = new Set([
  "missing_config",
  "invalid_subject",
  "timeout",
  "network",
  "invalid_response",
  "authorization",
  "retryable",
  "provider",
]);

/**
 * Only fixed provider categories may cross the orchestration boundary.  The
 * RevenueCat adapter currently returns these values, but this guard also
 * protects the log/RPC code if a future adapter accidentally includes a raw
 * response or secret in its reason.
 */
export function safeRevenueCatReason(reason: string): string {
  return SAFE_REVENUECAT_REASONS.has(reason) ? reason : "provider";
}

function safeStepCode(code: string | undefined, fallback: string): string {
  if (!code || !/^[A-Za-z0-9_.-]{1,128}$/.test(code)) return fallback;
  return code;
}

async function recordSafely(
  deps: AccountDeletionOrchestrationDeps,
  status: RevenueCatDeletionRecordStatus,
  errorCode: string | null,
): Promise<boolean> {
  try {
    return await deps.recordRevenueCatDeletion(status, errorCode);
  } catch {
    // Recording is a safety ledger operation.  Never let an exception expose
    // a provider/DB error or advance to a later destructive step.
    return false;
  }
}

/**
 * Execute account deletion's irreversible steps in one order:
 *
 *   RevenueCat customer -> local purge -> canonical outbox finalize -> Auth
 *
 * The handler supplies all side effects through dependencies.  This keeps the
 * function import-safe for tests (no Deno.serve call) and makes it impossible
 * for a finalize failure to fall through to Auth deletion.
 */
export async function orchestrateAccountDeletion(
  deps: AccountDeletionOrchestrationDeps,
): Promise<AccountDeletionOutcome> {
  if (deps.deleteExternalCustomer) {
    let external: RevenueCatCustomerDeletionResult;
    try {
      external = await deps.deleteRevenueCatCustomer();
    } catch {
      // The provider adapter normally converts throws to a bounded result.  A
      // defensive catch keeps an unexpected adapter failure retryable and
      // prevents purge/Auth from running.
      const recorded = await recordSafely(
        deps,
        "failed",
        "provider_network",
      );
      return recorded
        ? { ok: false, stage: "external", reason: "network" }
        : { ok: false, stage: "external_record", code: "record_failed" };
    }

    if (!external.ok) {
      const reason = safeRevenueCatReason(external.reason);
      const recorded = await recordSafely(
        deps,
        "failed",
        `provider_${reason}`,
      );
      return recorded
        ? { ok: false, stage: "external", reason }
        : { ok: false, stage: "external_record", code: "record_failed" };
    }

    if (!await recordSafely(deps, "succeeded", null)) {
      return { ok: false, stage: "external_record", code: "record_failed" };
    }
  }

  let purge: AccountDeletionStepResult;
  try {
    purge = await deps.purgeLocalData();
  } catch {
    purge = { ok: false, code: "purge_failed" };
  }
  if (!purge.ok) {
    if (deps.deleteExternalCustomer) {
      await recordSafely(
        deps,
        "local_cleanup_failed",
        safeStepCode(purge.code, "purge_failed"),
      );
    }
    return {
      ok: false,
      stage: "purge",
      code: safeStepCode(purge.code, "purge_failed"),
    };
  }

  if (deps.hasExternalOutbox) {
    let finalized = false;
    try {
      finalized = await deps.finalizeRevenueCatDeletion();
    } catch {
      finalized = false;
    }
    if (!finalized) return { ok: false, stage: "finalize" };
  }

  let authDelete: AccountDeletionStepResult;
  try {
    authDelete = await deps.deleteAuthUser();
  } catch {
    authDelete = { ok: false, code: "auth_delete_failed" };
  }
  if (!authDelete.ok) {
    if (deps.deleteExternalCustomer) {
      // Finalize has already removed the canonical outbox row.  This record is
      // intentionally best-effort: a retry creates a fresh row, repeats the
      // idempotent purge, treats RevenueCat 404 as success, and converges.
      await recordSafely(
        deps,
        "local_cleanup_failed",
        safeStepCode(authDelete.code, "auth_delete_failed"),
      );
    }
    return {
      ok: false,
      stage: "auth",
      code: safeStepCode(authDelete.code, "auth_delete_failed"),
    };
  }

  return { ok: true };
}
