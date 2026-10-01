import { z } from "zod";
import { isCurrentLocationArea } from "./providers/area.ts";

export const currentLocationScopeSchema = z.object({
  type: z.literal("current_location"),
}).strict();

// #509 の Broad Discovery が扱う anchor 集合の上限に合わせる。scope の
// 要素数は provider 呼び出し予算でも再検証されるが、LLM/API 境界で無制限の
// 配列を受け付けない。
export const LOCATION_SCOPE_MAX_ITEMS = 50;
export const LOCATION_SCOPE_TEXT_MAX = 120;
const scopeTextSchema = z.string().min(1).max(LOCATION_SCOPE_TEXT_MAX);
const scopeTextListSchema = z.array(scopeTextSchema).min(2).max(
  LOCATION_SCOPE_MAX_ITEMS,
);

// LocationScope is the only rail-related data the LLM may emit.  In
// particular, a station sequence is never accepted from model output.
// The point variant has a semantic refinement (current-location text must use
// current_location). Zod's discriminatedUnion rejects refined ZodEffects, so
// keep the same tagged union semantics with z.union and validate the tag in
// each object branch.
export const locationScopeSchema = z.union([
  // current_location は parser/API 互換のタグとして保持する。N02 resolver
  // は座標を扱わず、実行時は既存の area 経路へ委譲する。
  currentLocationScopeSchema,
  z.object({
    type: z.literal("point"),
    place: scopeTextSchema,
  })
    .strict()
    .refine((value) => !isCurrentLocationArea(value.place), {
      message: "現在地は current_location scope を使用してください",
    }),
  z.object({
    type: z.literal("any_of"),
    places: scopeTextListSchema,
  }).strict(),
  z.object({
    type: z.literal("multi_origin"),
    origins: scopeTextListSchema,
  }).strict(),
  z.object({
    type: z.literal("line"),
    line: scopeTextSchema,
    operator: scopeTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("between"),
    from: scopeTextSchema,
    to: scopeTextSchema,
    line: scopeTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("corridor"),
    from: scopeTextSchema,
    to: scopeTextSchema,
    line: scopeTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("station_hops"),
    origin: scopeTextSchema,
    maxStops: z.number().int().min(0).max(100),
    line: scopeTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("travel_time"),
    origin: scopeTextSchema,
    maxMinutes: z.number().int().min(1).max(24 * 60),
  }).strict(),
]);

export type LocationScope = z.infer<typeof locationScopeSchema>;

export type LocationScopeResolution =
  | { status: "resolved"; scope: LocationScope; source: "metadata" | "query" }
  | { status: "absent" }
  | { status: "invalid" };

// 日本語には一般的な単語境界が無いため、前後を明示して「こころ」等の部分一致を避ける。
const CURRENT_LOCATION_IN_TEXT =
  /(?:^|[\s:/、。,.!?！？「」『』()（）])(?:現在地|現在位置|現在地点|今いる場所|いまいる場所|今いるところ|いまいるところ|この辺|このへん|ここらへん|ここら|ここ)(?:付近|周辺|近辺|辺り|あたり|近く|そば|エリア)?(?=$|[\s/、。,.!?！？のではにへから])/u;

// モデルが area/locationScope へ current_location を出力しても、入力文に
// 現在地を指す語が実在しなければ信用しない防御 (#317: 場所語が一切無い
// 入力に対してモデルが current_location を自己判断で補ってしまう事例を確認)。
export function queryMentionsCurrentLocation(query: string): boolean {
  return CURRENT_LOCATION_IN_TEXT.test(
    query.normalize("NFKC").replace(/[\u301c〜～]/g, "〜"),
  );
}

// 否定・対比節は、単純な抽出では肯定されたscopeと区別できないため
// 復元せず、モデルの解析結果または通常の検索経路に委ねる。
const AMBIGUOUS_LOCATION_NEGATION =
  /(?:ではなく|でなく|じゃなく|ではない|でない|じゃない|ではありません|でありません|じゃありません)/u;

/**
 * The home form prefixes a manually selected place with `場所:` before it
 * joins the remaining conditions with `/`.  Keep this marker detectable so
 * create-investigation can prefer the deterministic point scope over an
 * over-eager model-generated rail scope.
 */
export function queryHasExplicitLocationMarker(query: string): boolean {
  return /(?:^|[\s/、。,.!?！？「」『』()（）［］【】])(?:場所|エリア|地域|地点)\s*[:：]/u
    .test(
      query.normalize("NFKC"),
    );
}

// 「線」が鉄道路線を表す文脈だけを受け付ける。通常のエリア文字列から
// 路線名や駅名を推測しないため、検索条件の明示的な手がかりに限定する。
const RAIL_LINE_IN_TEXT =
  /(?=(?:^|[\s:/、。,.!?！？「」『』()（）［］【】]|(?:を|で|に|へ|は|が|と|や|も|から|より))([\p{L}\p{N}・]+?線)(?=\s*(?:沿線|沿い|で|の|駅|周辺|付近|上|利用|沿って|を|で|に|へ|は|が|と|や|も|から|より|$|[、。,.!?！？「」『』()（）［］【】])))/gu;

function lineFromText(query: string): string | undefined {
  const candidates = [...query.matchAll(RAIL_LINE_IN_TEXT)].map((match) => ({
    line: match[1].trim(),
    atStart: match.index === 0,
  }));
  const distinct = [...new Map(candidates.map((candidate) => [
    `${candidate.atStart ? "start" : "boundary"}:${candidate.line}`,
    candidate,
  ])).values()];
  const start = distinct.find((candidate) => candidate.atStart);
  const boundary = distinct.filter((candidate) => !candidate.atStart);

  // 「焼肉を西武池袋線で」の先頭からの過剰捕捉と、助詞後の実トークンが
  // 同時に見つかる場合は、先頭候補の末尾が実トークンであるときだけ採用する。
  if (start && boundary.length === 1) {
    const candidate = boundary[0].line;
    const prefix = start.line.endsWith(candidate)
      ? start.line.slice(0, -candidate.length)
      : "";
    if (prefix && /(?:を|で|に|へ|は|が|と|や|も|から|より)$/u.test(prefix)) {
      return candidate;
    }
    return undefined;
  }
  if (!start && boundary.length === 1) return boundary[0].line;
  if (start && boundary.length === 0) return start.line;
  return undefined;
}

function scopeToken(value: string): string {
  return value.replace(/^[\s:：]+|[\s、。,.!?！？「」『』]+$/gu, "").trim();
}

function parseAnyOfScope(query: string): LocationScope | undefined {
  // 「から」の「か」や日付の「8/23」を選言として誤認しない。slash は
  // 数字に隣接しない場合だけ場所の区切りとして扱う。
  const match = query.match(
    /([^、。\s,，/／]+?)\s*(?:か(?!ら)(?=[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}\p{N}])|または|又は|(?<![\p{L}\p{N}])or(?![\p{L}\p{N}]))\s*([^、。\s,，/／]+?)(?=\s*(?:のどちらか|どちらか|で|に|へ|を|付近|周辺|$))/iu,
  ) ?? query.match(
    /([^、。\s,，/／]+?)\s*(?<![0-9０-９])[\/／](?![0-9０-９])\s*([^、。\s,，/／]+?)(?=\s*(?:のどちらか|どちらか|で|に|へ|を|付近|周辺|$))/iu,
  );
  if (!match) return undefined;
  const places = [scopeToken(match[1]), scopeToken(match[2])];
  if (places.some((place) => !place) || places[0] === places[1]) {
    return undefined;
  }
  const parsed = locationScopeSchema.safeParse({ type: "any_of", places });
  return parsed.success ? parsed.data : undefined;
}

function parseMultiOriginScope(query: string): LocationScope | undefined {
  // 「AとBから」「A・Bから」のように、複数の出発地を明示した場合だけ
  // multi_origin とする。travel matrix / 公平性の最適化は #146 の責務であり、
  // ここでは入力されたorigin文字列をそのまま保持する。
  const match = query.match(
    /([^、。\s!?！？]+(?:\s*(?:と|、|,|，|・|及び|および|＆|&)\s*[^、。\s!?！？]+)+)\s*から/u,
  );
  if (!match) return undefined;
  const origins = match[1].split(/\s*(?:と|、|,|，|・|及び|および|＆|&)\s*/u)
    .map(scopeToken).filter(Boolean);
  if (origins.length < 2 || new Set(origins).size !== origins.length) {
    return undefined;
  }
  const parsed = locationScopeSchema.safeParse({
    type: "multi_origin",
    origins,
  });
  return parsed.success ? parsed.data : undefined;
}

function parsePointScope(query: string): LocationScope | undefined {
  // fallback parser は駅・地名の辞書を持たないため、明示された場所 marker
  // または「駅周辺/付近」だけを point として扱う。一般語を地名へ推測しない。
  const marked = query.match(
    /(?:場所|エリア|地域|地点)\s*[:：]?\s*([^、。\s\/／]+?)(?=\s*(?:で|に|の|付近|周辺|$|[\/／]))/u,
  );
  const suffix = query.match(
    /([^、。\s]+?)(?:駅)?(?:周辺|付近|近く)(?=\s*(?:で|に|の|$))/u,
  );
  const place = scopeToken(marked?.[1] ?? suffix?.[1] ?? "");
  if (!place || isCurrentLocationArea(place)) return undefined;
  const parsed = locationScopeSchema.safeParse({ type: "point", place });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Deterministic parser used for fixtures and as a safe recovery path when
 * the model omits an explicit locationScope. It never invents a line or
 * station from ordinary area text.
 */
export function parseLocationScopeFromText(
  query: string,
): LocationScope | undefined {
  const normalized = query.normalize("NFKC").replace(/[\u301c〜～]/g, "〜")
    .trim();
  if (AMBIGUOUS_LOCATION_NEGATION.test(normalized)) return undefined;
  if (CURRENT_LOCATION_IN_TEXT.test(normalized)) {
    return { type: "current_location" };
  }
  // The web form's explicit `場所:` marker is a single selected point.  Give
  // it precedence over alternative/rail heuristics that may match a later
  // condition after the form joins fields with `/`.
  if (queryHasExplicitLocationMarker(normalized)) {
    const explicitPoint = parsePointScope(normalized);
    if (explicitPoint) return explicitPoint;
  }
  const hops = normalized.match(/(.+?)から\s*(\d+)\s*駅(?:以内|まで)?/);
  if (hops) {
    const rawOrigin = hops[1].trim();
    const line = lineFromText(normalized);
    const origin = line && rawOrigin.startsWith(line)
      ? rawOrigin.slice(line.length).replace(/^(?:の|で)/u, "").trim()
      : rawOrigin;
    if (origin) {
      return {
        type: "station_hops",
        origin,
        maxStops: Number(hops[2]),
        ...(line ? { line } : {}),
      };
    }
  }
  const travel = normalized.match(/(.+?)から\s*(\d+)\s*分(?:以内|圏内)?/);
  if (travel) {
    return {
      type: "travel_time",
      origin: travel[1].trim(),
      maxMinutes: Number(travel[2]),
    };
  }
  const multiOrigin = parseMultiOriginScope(normalized);
  if (multiOrigin) return multiOrigin;
  const between = normalized.match(
    /([^、。\s]+?)\s*(?:〜|-|から)\s*([^、。\s]+?)(?=\s*(?:のどこか|の間|へ行く途中|の途中|の沿線|沿線|沿い|間|で|$))/u,
  );
  if (between && between[1] !== between[2]) {
    const line = lineFromText(normalized);
    return {
      type: /沿線|沿い|途中/u.test(normalized) ? "corridor" : "between",
      from: between[1],
      to: between[2],
      ...(line ? { line } : {}),
    };
  }
  const anyOf = parseAnyOfScope(normalized);
  if (anyOf) return anyOf;
  const line = lineFromText(normalized);
  if (line) return { type: "line", line };
  return parsePointScope(normalized);
}

/**
 * Resolve persisted scope metadata without allowing a malformed value to
 * silently fall back to a broad provider search. Null/omitted metadata is the
 * compatibility case for older investigations, so only that case may use the
 * deterministic query parser.
 */
export function resolveLocationScope(
  query: string,
  storedScope?: unknown,
): LocationScopeResolution {
  if (storedScope !== undefined && storedScope !== null) {
    const parsed = locationScopeSchema.safeParse(storedScope);
    return parsed.success
      ? { status: "resolved", scope: parsed.data, source: "metadata" }
      : { status: "invalid" };
  }
  const fallback = locationScopeSchema.safeParse(
    parseLocationScopeFromText(query),
  );
  return fallback.success
    ? { status: "resolved", scope: fallback.data, source: "query" }
    : { status: "absent" };
}
