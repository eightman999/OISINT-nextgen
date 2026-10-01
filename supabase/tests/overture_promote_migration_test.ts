// promote step のゲートが migration に実在することの回帰テスト (#559)。
// 「license / human label のゲートが fail-closed で効く」は Acceptance Criteria なので、
// リファクタで条件が抜け落ちたら落ちるようにしておく。
import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/202608210001_overture_canonical_promote.sql",
    import.meta.url,
  ),
);

function functionBody(name: string, nextMarker: string): string {
  const start = migration.indexOf(`create or replace function ${name}`);
  const end = migration.indexOf(nextMarker, start);
  assert(start >= 0, `${name} must exist in the overture migration`);
  assert(end > start, `${name} must have a following migration marker`);
  return migration.slice(start, end);
}

const validate = functionBody(
  "benchmark.validate_overture_promotion",
  "create or replace function benchmark.promote_overture_region",
);
const promote = functionBody(
  "benchmark.promote_overture_region",
  "create or replace function public.search_place_discovery_index",
);

Deno.test("license ゲートは dataset 台帳と観測 1 行ごとの両方を検査する", () => {
  assertStringIncludes(validate, "license_status <> 'verified'");
  assertStringIncludes(validate, "not benchmark.is_cdla_permissive(license)");
  assertStringIncludes(
    validate,
    "not benchmark.is_cdla_permissive(o.source_license)",
  );
  // 許容ライセンスの語彙を勝手に広げない
  assertStringIncludes(migration, "like 'CDLA-Permissive-%'");
});

Deno.test("human label ゲートは実測 precision のみを使い、ラベル不足で止まる", () => {
  assertStringIncludes(validate, "human_label = 'true_positive'");
  assertStringIncludes(validate, "human_label = 'false_positive'");
  assertStringIncludes(validate, "labeled_matches < p_min_labeled_matches");
  assertStringIncludes(validate, "precision_value < p_min_match_precision");
});

Deno.test("promote は validate 不合格なら例外で止まる (fail-closed)", () => {
  assertStringIncludes(promote, "benchmark.validate_overture_promotion(");
  assertStringIncludes(promote, "if not (validation ->> 'ok')::boolean then");
  assertStringIncludes(
    promote,
    "raise exception 'overture promote gate failed",
  );
});

Deno.test("promote は決定済みの provenance 契約どおりに link を書く", () => {
  assertStringIncludes(
    promote,
    "'persistent', null, 'overture_cdla_attribution'",
  );
  assertStringIncludes(
    promote,
    "on conflict (provider, provider_place_id) do update",
  );
});

Deno.test("廃業が確定した観測は canonical へ入れない", () => {
  assertStringIncludes(promote, "coalesce(n.closed, false) = false");
});

Deno.test("営業状態を canonical へ持ち込まない (operating_status は根拠にならない)", () => {
  // index テーブルにも places.metadata にも operating_status を作らない (#559 AC / §30)
  assertFalse(migration.includes("operating_status text"));
  assertFalse(migration.includes("'operatingStatus'"));
});

Deno.test("discovery index は anon に開かず、RPC は自前 index だけを読む", () => {
  assertStringIncludes(
    migration,
    "grant select on public.place_discovery_index to authenticated",
  );
  assertFalse(migration.includes("to anon"));
  const rpc = migration.slice(
    migration.indexOf(
      "create or replace function public.search_place_discovery_index",
    ),
  );
  assertStringIncludes(rpc, "from public.place_discovery_index i");
  assertStringIncludes(rpc, "st_dwithin(");
});

Deno.test("promote / validate はクライアントから呼べない", () => {
  assertStringIncludes(
    migration,
    "revoke all on function benchmark.promote_overture_region",
  );
  assertStringIncludes(
    migration,
    "grant execute on function benchmark.promote_overture_region(text, text, integer, double precision) to service_role",
  );
});

Deno.test("PostGIS を public へ入れず extensions を search_path で解決する", () => {
  assertStringIncludes(
    validate,
    "set search_path = extensions, public, benchmark",
  );
  assertStringIncludes(
    promote,
    "set search_path = extensions, public, benchmark",
  );
});

// ---- 敵対的レビュー (2026-08-21) で実再現した fail-open の回帰テスト ----

Deno.test("閾値に NULL / 負値を渡してゲートを無効化できない", () => {
  // 実測: 修正前は validate('region', null, null) が ok=true を返し、
  // ラベル 1 件・precision 0.0 でも promote を通せた
  assertStringIncludes(
    validate,
    "p_min_labeled_matches is null or p_min_labeled_matches < 1",
  );
  assertStringIncludes(validate, "p_min_match_precision is null");
  assertStringIncludes(
    validate,
    "p_min_match_precision <= 0 or p_min_match_precision > 1",
  );
  assertStringIncludes(
    validate,
    "raise exception 'promote ゲートの閾値が不正です",
  );
});

Deno.test("provider_place_id の重複で promote 全体が落ちない", () => {
  assertStringIncludes(promote, "select distinct on (o.provider_record_id)");
});

Deno.test("対象から外れた店は discovery index から取り下げる", () => {
  assertStringIncludes(promote, "delete from public.place_discovery_index i");
  assertStringIncludes(promote, "not exists (");
  assertStringIncludes(promote, "removed_index_count = removed_count");
});

Deno.test("discovery の半径に上限がある (全国スキャンを走らせられない)", () => {
  assertStringIncludes(
    migration,
    "least(greatest(coalesce(p_radius_m, 0), 0), 50000)",
  );
});

Deno.test("security definer の search_path は pg_temp を末尾に固定する", () => {
  assertStringIncludes(
    validate,
    "set search_path = extensions, public, benchmark, pg_temp",
  );
  assertStringIncludes(
    promote,
    "set search_path = extensions, public, benchmark, pg_temp",
  );
});

// ---- 本番適用後に実スキーマで検出した GRANT 欠陥の回帰テスト (202608220001) ----
// 202608210001 は `revoke ... from public` しか書いておらず、Supabase の
// default privileges 由来で anon に付いた GRANT が残っていた。
// PostgreSQL の PUBLIC 疑似ロールと anon ロールは別物である点を落とさない。
const hardening = await Deno.readTextFile(
  new URL(
    "../migrations/202608220001_overture_discovery_grant_hardening.sql",
    import.meta.url,
  ),
);

Deno.test("discovery RPC / index から anon 権限を明示的に剥がす", () => {
  assertStringIncludes(hardening, "from public, anon;");
  assertStringIncludes(
    hardening,
    "revoke all on table public.place_discovery_index from anon;",
  );
  assertStringIncludes(
    hardening,
    "revoke insert, update, delete, truncate, references, trigger",
  );
});

Deno.test("意図した権限は残す (revoke のやりすぎを防ぐ)", () => {
  assertStringIncludes(
    hardening,
    "grant select on table public.place_discovery_index to authenticated;",
  );
  assertStringIncludes(hardening, "to service_role, authenticated;");
});

Deno.test("適用結果を実測して fail-closed にする", () => {
  assertStringIncludes(hardening, "has_function_privilege('anon'");
  assertStringIncludes(hardening, "has_table_privilege('anon'");
  assertStringIncludes(
    hardening,
    "raise exception 'anon still holds EXECUTE on public.search_place_discovery_index'",
  );
  assertStringIncludes(
    hardening,
    "raise exception 'authenticated lost SELECT on public.place_discovery_index'",
  );
});
