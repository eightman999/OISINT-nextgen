/*
 * Cloudflare secrets are intentionally not declared in wrangler.toml: Wrangler
 * has no TOML `secrets.required` binding, and silently ignoring that section
 * would create a false deploy guarantee. The production workflow performs the
 * value-free presence/length preflight and synchronizes these names. Keep this
 * type-only augmentation next to Wrangler's generated vars/binding types.
 */
interface CloudflareEnv {
  RATE_LIMIT_SECRET: string;
  EGRESS_GATEWAY_SECRET: string;
  RUN_QUEUE_DRAIN_KEY: string;
  /** `wrangler dev` のlocal Supabase接続だけで与える。本番設定には置かない。 */
  LOCAL_SUPABASE_DEV?: string;
}

declare namespace Cloudflare {
  interface Env {
    RATE_LIMIT_SECRET: string;
    EGRESS_GATEWAY_SECRET: string;
    RUN_QUEUE_DRAIN_KEY: string;
    LOCAL_SUPABASE_DEV?: string;
  }
}
