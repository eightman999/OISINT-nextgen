import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseOperationError } from "./database_error.ts";

export const serverEntitlementSchema = z.object({
  tier: z.enum(["free", "plus"]),
  entitlement_id: z.literal("plus"),
  product_id: z.enum(["oisint_plus_monthly", "oisint_plus_annual"]).nullable(),
  offering_id: z.literal("default"),
  lifecycle_state: z.enum([
    "free",
    "active",
    "canceled",
    "grace",
    "billing_issue",
    "expired",
  ]),
  expires_at: z.string().nullable(),
  will_renew: z.boolean().nullable(),
  grace_period_expires_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}).strict();

export type ServerEntitlement = z.infer<typeof serverEntitlementSchema>;

function oneRpcRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

/** 認証済みJWTの subject を DB が決め、client入力の user id を受けない resolver。 */
export async function resolveCurrentEntitlement(
  db: SupabaseClient,
): Promise<ServerEntitlement> {
  const { data, error } = await db.rpc("resolve_current_entitlement");
  if (error) {
    throw new DatabaseOperationError(
      "resolve_current_entitlement",
      error.message,
    );
  }
  const parsed = serverEntitlementSchema.safeParse(oneRpcRow(data));
  if (!parsed.success) {
    throw new DatabaseOperationError(
      "resolve_current_entitlement",
      "invalid entitlement shape",
    );
  }
  return parsed.data;
}

/**
 * Resolve a permanent authenticated subject for the run acceptance boundary.
 * The caller must obtain userId from authenticate(req); RevenueCat identifiers
 * and client-declared tiers are intentionally not accepted here. Any resolver
 * failure returns null so the caller can persist the fail-closed Free policy.
 */
export async function resolveEntitlementForUser(
  db: SupabaseClient,
  userId: string,
): Promise<ServerEntitlement | null> {
  try {
    const { data, error } = await db.rpc("resolve_entitlement_for_user", {
      p_user_id: userId,
    });
    if (error) return null;
    const parsed = serverEntitlementSchema.safeParse(oneRpcRow(data));
    return parsed.success ? parsed.data : null;
  } catch {
    // Resolver/network failures must not grant Plus; the caller selects Free.
    return null;
  }
}

/** service_role の server gate 専用。client/Edgeの公開APIから直接呼び出さない。 */
export async function isPlusForUser(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("is_plus_for_user", {
    p_user_id: userId,
  });
  if (error) {
    throw new DatabaseOperationError("is_plus_for_user", error.message);
  }
  if (typeof data !== "boolean") {
    throw new DatabaseOperationError(
      "is_plus_for_user",
      "invalid boolean result",
    );
  }
  return data;
}
