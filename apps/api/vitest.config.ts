// apps/api の Worker テスト設定 (#174)。
// @cloudflare/vitest-pool-workers で workerd 上でテストを実行する。
//
// バージョン選定メモ (2026-08-16 統合時点):
// - 0.13.0 以降が vitest 4 対応。旧 defineWorkersConfig ("./config" export) は
//   廃止され、cloudflareTest プラグインを vitest/config の defineConfig に渡す。
// - #174 のworkerd方針を維持し、npm auditが修正版として指定する0.21.3を
//   exact pinする。0.15.1はhigh 6件、0.18.8もhigh 1件が再現したため不採用。
//   0.21.3はwrangler 4.123.0と同じtoolchain世代で、下のcontract suiteで検証する。
// - compatibility_date を 2026-04-26 より新しくする場合は pool-workers を
//   再評価する。CIは #210 で Node 22へ統一済み。
//
// wrangler.toml を読み込むが、テストは app.request() に偽の env を渡すため
// [vars] の実 URL へネットワークアクセスすることは無い (fetch は全て stub)。
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // 同梱workerdの最新対応日は2026-08-18。本番設定の現日(2026-08-24)
        // を未対応バイナリへ渡さず、実workerd検証可能な日を明示する。
        compatibilityDate: "2026-08-18",
        // vitest ランナーを workerd 内で動かすために必須
        compatibilityFlags: ["nodejs_compat"],
        // 本番secretは投入しない。required secretのlocal warningを抑え、
        // workerd bindingを明示したテスト専用fixture。
        bindings: {
          RATE_LIMIT_SECRET: ["test-only-rate-limit", "fixture", "00000000"].join("-"),
          EGRESS_GATEWAY_SECRET: ["test-only-egress-gateway", "fixture", "00000000"].join("-"),
          RUN_QUEUE_DRAIN_KEY: ["test-only-drain", "fixture", "0123456789ab"].join("-"),
        },
      },
    }),
  ],
  test: {
    include: [
      "src/calendarDate.test.ts",
      "src/index.test.ts",
      "src/worker.test.ts",
      "src/replay_guard.workerd.test.ts",
    ],
  },
});
