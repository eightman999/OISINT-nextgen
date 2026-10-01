// MockCandidateResearch = mock 用 AIProvider (spec.md §26 / contracts/providers.md)
// parse / investigate / embed の全てを外部 API 非依存で返す。
// 外部 API 停止時に mock でデモ完走できることが §5.4 Fallback / §41 の要件。
import type { StructuredClaim } from "../types.ts";
import {
  AI_OUTPUT_LIMITS,
  type GroundedCandidateInvestigation,
  type ParsedRequirements,
} from "../validation.ts";
import type { AIProvider, CandidateInvestigationInput } from "./types.ts";
import { attestRequirementSourceText } from "../requirement_source.ts";
import { dedupeRequirements } from "../requirement_dedupe.ts";
import { parseLocationScopeFromText } from "../rail_scope.ts";
import { parseStructuredFilterRequirement } from "../facts.ts";

const EMBEDDING_DIM = 768;

function boundOutputClaim(claim: StructuredClaim): StructuredClaim {
  return {
    ...claim,
    rawText: claim.rawText.slice(0, AI_OUTPUT_LIMITS.claimRawTextChars),
  };
}

// 決定的な擬似 embedding: テキストの FNV-1a hash を seed にした xorshift で 768 次元を生成し正規化。
// 次元と型の整合 (§16.3) の検証が目的。意味的類似は表現しない。
function pseudoEmbedding(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  const v = new Array<number>(EMBEDDING_DIM);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    const x = (state / 0xffffffff) * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

// 単純キーワード規則で requirement を分解する (mock 専用。live は Gemini §5)
function parseByKeywords(query: string): ParsedRequirements["requirements"] {
  const reqs: ParsedRequirements["requirements"] = [];
  const add = (
    text: string,
    normalizedText: string,
    kind: ParsedRequirements["requirements"][number]["kind"],
    priority: "must" | "should" | "nice",
    weight: number,
  ) => {
    if (reqs.some((req) => req.text === text && req.kind === kind)) return;
    reqs.push({ text, normalizedText, kind, priority, weight });
  };

  const addDeterministic = (
    text: string,
    normalizedText: string,
    kind: "budget" | "time" | "payment" | "reservation" | "party_size",
    priority: "must" | "should" | "nice",
    weight: number,
  ) => {
    const attested = attestRequirementSourceText({
      kind,
      text,
      normalizedText,
      rawQuery: query,
    });
    if (attested) {
      add(text, normalizedText, kind, priority, weight);
      return;
    }
    // 複合・否定・選言の節は肯定的なdeterministic kindへ変換しない。
    // 条件自体は落とさず semantic-only の other としてunknown側へ残す。
    const canonicalText = text.normalize("NFKC")
      .replace(/([0-9]),(?=[0-9]{3}(?:\D|$))/g, "$1")
      .replaceAll(/\s+/g, "");
    const sourceClause = query
      .replace(/([0-9]),(?=[0-9]{3}(?:\D|$))/g, "$1")
      .split(/[。．.!！?？、,，;；\n\r]+/)
      .map((clause) => clause.trim())
      .find((clause) =>
        clause.normalize("NFKC").replaceAll(/\s+/g, "").includes(canonicalText)
      );
    if (sourceClause) {
      add(sourceClause, sourceClause, "other", priority, weight);
    }
  };

  const budget = query.match(
    /(?:予算\s*)?((?:\d{1,3}(?:[,，]\d{3})+|\d{3,5}))\s*円(?:\s*(以内|以下|まで|未満|前後|くらい))?(?:\s*で)?/,
  );
  if (budget) {
    const amount = budget[1].replace(/[,，]/g, "");
    const normalized = budget[2] &&
        ["以内", "以下", "まで", "未満"].includes(budget[2])
      ? budget[0].normalize("NFKC").replaceAll(/\s+/g, "")
      : `予算 ${amount}円前後`;
    addDeterministic(budget[0], normalized, "budget", "must", 1.0);
  } else {
    const vague = query.match(/安い|お手頃|手頃|リーズナブル|格安/);
    if (vague) {
      // 明示金額が無い「安い」系 (#312。上限正規化は requirement_matching.ts)
      addDeterministic(vague[0], "安い価格帯", "budget", "must", 1.0);
    }
  }
  const time = query.match(/モーニング|朝食|朝/);
  if (time) {
    addDeterministic(
      time[0],
      "朝の時間帯に営業している",
      "time",
      "must",
      1.0,
    );
  }
  const payment = query.match(
    /(?:クレジットカード|クレカ|カード)(?:利用可能|利用可|払いしたい|で払いたい|を使いたい|決済可能|決済可|対応|可)/,
  );
  if (payment) {
    addDeterministic(
      payment[0],
      "クレジットカード利用可能",
      "payment",
      "must",
      1.0,
    );
  }
  const nonSmoking = query.match(/(?:全席)?禁煙/);
  if (nonSmoking) {
    add(nonSmoking[0], "禁煙", "atmosphere", "should", 0.8);
  }
  const wifi = query.match(/(?:無料)?Wi-?Fi|無線LAN/i);
  if (wifi) {
    add(wifi[0], "Wi-Fi", "other", "should", 0.7);
  }
  const childFriendly = query.match(
    /(?:子ども|子供|子)連れ(?:OK|可|歓迎|対応)?/i,
  );
  if (childFriendly) {
    add(childFriendly[0], "子連れOK", "other", "should", 0.8);
  }
  const walking = query.match(/徒歩[0-9]+分(?:以内|以下|まで)/);
  if (walking) {
    add(walking[0], walking[0], "access", "should", 0.8);
  }
  if (/肉|焼肉|ステーキ/.test(query)) {
    add("肉", "肉料理が主体の店", "cuisine", "must", 1.0);
  }
  if (/静か|落ち着/.test(query)) {
    add("静かめ", "静かで落ち着いた雰囲気", "atmosphere", "should", 0.8);
  }
  const privateRoom = query.match(/個室/);
  if (privateRoom) {
    addDeterministic(
      privateRoom[0],
      "個室あり",
      "reservation",
      "should",
      0.8,
    );
  }
  const party = query.match(/(\d+)\s*人/);
  if (party) {
    addDeterministic(
      party[0],
      `${party[1]}人で利用可能`,
      "party_size",
      "must",
      1.0,
    );
  }
  if (/辛い.*避け|辛くない/.test(query)) {
    add("辛い料理は避けたい", "辛くない料理がある", "dietary", "should", 0.8);
  }
  if (reqs.length === 0) {
    add(query.slice(0, 20), query.slice(0, 20), "other", "should", 0.5);
  }
  return reqs;
}

const AREAS = [
  "池袋",
  "新宿",
  "渋谷",
  "上野",
  "銀座",
  "秋葉原",
  "品川",
  "横浜",
];

export class MockAIProvider implements AIProvider {
  parseRequirements(
    query: string,
    _signal?: AbortSignal,
  ): Promise<ParsedRequirements> {
    const locationScope = parseLocationScopeFromText(query);
    const scopedArea = locationScope?.type === "point"
      ? locationScope.place
      : locationScope?.type === "any_of"
      ? locationScope.places[0]
      : locationScope?.type === "multi_origin"
      ? locationScope.origins[0]
      : locationScope?.type === "between" ||
          locationScope?.type === "corridor"
      ? locationScope.from
      : locationScope?.type === "station_hops" ||
          locationScope?.type === "travel_time"
      ? locationScope.origin
      : undefined;
    const area = locationScope?.type === "current_location"
      ? "現在地"
      : scopedArea ?? AREAS.find((a) => query.includes(a)) ?? "池袋";
    const date = new Date(Date.now() + 9 * 3600_000);
    const title = `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${area} 夜飯`;
    return Promise.resolve({
      title,
      normalizedQuery: query.replace(/\s+/g, " ").trim(),
      area,
      locationScope,
      requirements: dedupeRequirements(parseByKeywords(query)),
    });
  }

  investigateCandidate(
    input: CandidateInvestigationInput,
  ): Promise<GroundedCandidateInvestigation> {
    const base =
      `https://mock.oisint.example/research/${input.place.providerPlaceId}`;
    const officialUrl = `${base}/official`;
    const reviewUrl = `${base}/reviews`;
    const claimsByKey = new Map(input.knownClaims.map((c) => [c.key, c]));

    // 矛盾デモ (§15): mock-001 のみ、公式サイト側の閉店時刻を place provider 側 (24:00) から 60 分ずらす。
    // 値はデモ用の作為データ (店舗実データではない) であることを rawText に明示する
    const officialClaims: StructuredClaim[] = [];
    if (input.place.providerPlaceId === "mock-001") {
      officialClaims.push({
        key: "opening_hours",
        value: "11:30-23:00",
        rawText: "デモ公式: 営業時間 11:30〜23:00",
      });
    }

    const findings = input.requirements.map((req) => {
      const relevant = pickClaim(req, claimsByKey);
      if (relevant) {
        const ok = claimSatisfies(req, relevant);
        return {
          requirementId: req.id,
          state: ok ? ("match" as const) : ("mismatch" as const),
          confidence: ok ? 0.9 : 0.85,
          explanation: ok
            ? `店舗情報で確認: ${relevant.rawText}`
            : `店舗情報と不一致: ${relevant.rawText}`,
          sourceUrls: [officialUrl],
          claims: [
            relevant,
            ...officialClaims.filter((c) => c.key === relevant.key),
          ],
        };
      }
      if (req.kind === "atmosphere") {
        const noise = claimsByKey.get("noise_level");
        return {
          requirementId: req.id,
          state: noise?.value === "quiet"
            ? ("match" as const)
            : ("partial" as const),
          confidence: noise?.value === "quiet" ? 0.75 : 0.6,
          explanation: noise?.value === "quiet"
            ? "レビューで「落ち着いた店内」との記述を複数確認"
            : "レビューでは席間隔が広く比較的話しやすいとの記述あり",
          sourceUrls: [reviewUrl],
          claims: noise ? [noise] : [],
        };
      }
      return {
        requirementId: req.id,
        state: "unknown" as const,
        confidence: 0,
        explanation: "公開情報からは確認できませんでした",
        sourceUrls: [],
        claims: [],
      };
    });

    const outputFindings = (
      officialClaims.length > 0
        ? attachOfficialClaims(findings, officialClaims, officialUrl)
        : findings
    ).map((finding) => ({
      ...finding,
      claims: finding.claims.map(boundOutputClaim),
    }));

    return Promise.resolve({
      summary:
        `${input.place.name} の公開情報を確認しました。条件の多くは店舗情報とレビューで裏付けが取れています。`,
      searchQueries: [
        `${input.place.name} 公式 営業時間`,
        `${input.place.name} 口コミ 雰囲気`,
      ],
      citations: [
        { url: officialUrl, title: `${input.place.name} 公式サイト` },
        { url: reviewUrl, title: `${input.place.name} のレビュー` },
      ],
      findings: outputFindings,
    });
  }

  embed(texts: string[]): Promise<number[][]> {
    // 各文字列ごとに独立 vector (§5 Embedding Rule)
    return Promise.resolve(texts.map(pseudoEmbedding));
  }
}

type Finding = GroundedCandidateInvestigation["findings"][number];

// 公式サイト claim (矛盾ペア) がどの finding にも載らなかった場合、time 系 finding が無くても
// summary 相当の finding には付かないため、opening_hours claim を持つ finding が無ければ先頭に足す
function attachOfficialClaims(
  findings: Finding[],
  officialClaims: StructuredClaim[],
  officialUrl: string,
): Finding[] {
  const hasOpening = findings.some((f) =>
    f.claims.some((c) => c.key === "opening_hours")
  );
  if (hasOpening || findings.length === 0) return findings;
  const [first, ...rest] = findings;
  return [
    {
      ...first,
      sourceUrls: Array.from(new Set([...first.sourceUrls, officialUrl])),
      claims: [...first.claims, ...officialClaims],
    },
    ...rest,
  ];
}

function pickClaim(
  requirement: CandidateInvestigationInput["requirements"][number],
  claims: Map<StructuredClaim["key"], StructuredClaim>,
): StructuredClaim | undefined {
  const structuredFilter = parseStructuredFilterRequirement(
    requirement.normalizedText,
  );
  if (structuredFilter?.kind === "walk_limit") {
    return claims.get("nearest_station_walk_minutes");
  }
  if (structuredFilter?.kind === "boolean_filter") {
    return claims.get(structuredFilter.key);
  }
  switch (requirement.kind) {
    case "payment":
      return claims.get("card_accepted");
    case "budget":
      return claims.get("budget_dinner");
    case "cuisine":
      return claims.get("genre");
    case "party_size":
      return claims.get("capacity");
    case "time":
      return claims.get("opening_hours");
    default:
      return undefined;
  }
}

function claimSatisfies(
  requirement: CandidateInvestigationInput["requirements"][number],
  claim: StructuredClaim,
): boolean {
  const structuredFilter = parseStructuredFilterRequirement(
    requirement.normalizedText,
  );
  if (structuredFilter?.kind === "walk_limit") {
    return claim.key === "nearest_station_walk_minutes" &&
      typeof claim.value === "number" &&
      Number.isSafeInteger(claim.value) &&
      claim.value >= 0 && claim.value <= structuredFilter.maxMinutes;
  }
  if (structuredFilter?.kind === "boolean_filter") {
    return claim.key === structuredFilter.key &&
      claim.value === structuredFilter.desired;
  }
  switch (requirement.kind) {
    case "payment":
      return claim.value === true;
    case "budget":
      return true; // 区間の重なり判定は簡略化 (mock)
    case "cuisine": {
      const genres = Array.isArray(claim.value)
        ? (claim.value as string[])
        : [];
      return genres.some((g) => /肉|焼肉|バル|しゃぶ/.test(g));
    }
    case "party_size":
      return typeof claim.value === "number" && claim.value >= 3;
    case "time":
      return true;
    default:
      return true;
  }
}
