// SearchFetchResearchProvider (spec.md §5 Research Backend / 2026-08-15 改訂・grounding 廃止後の唯一の live 経路)
//   Serper で Web 検索 → 上位 URL を軽量フェッチ → Gemini (検索ツールなし・同時1〜2) が
//   Structured Output で claim 抽出・条件評価。
// citation = 実際に fetch できた URL のみ。モデルが生成した URL は採用しない (§5)。
// parse / research / embed は明示した責務別interfaceへ委譲する (#512)。
import {
  GoogleAIClient,
  INVESTIGATION_SCHEMA,
  type ModelInvestigation,
  modelInvestigationSchema,
  structuredCall,
} from "./google_ai.ts";
import { SerperSearchProvider } from "./serper.ts";
import {
  type FetchedPage,
  type FetchFailureReason,
  fetchPageTextWithReason,
} from "./fetcher.ts";
import { isFetchDenylisted } from "./fetch_denylist.ts";
import {
  compactKnownClaims,
  extractRelevantText,
  keywordsForKinds,
} from "./relevance.ts";
import type {
  GroundedCandidateInvestigation,
  ParsedRequirements,
} from "../validation.ts";
import type {
  AIProvider,
  CandidateInvestigationInput,
  EmbeddingProvider,
  ProviderInstrumentation,
  RequirementParser,
  ResearchEvaluationRequest,
  ResearchEvaluator,
  SearchFetchResearchDependencies,
} from "./types.ts";

const MAX_QUERIES = 3; // §5.4 Hard Rule 8
const MAX_FETCH_URLS = 3; // §5.4 軽量フェッチャ制約
const RETRY_PAGE_CHARS = 750; // Zod 失敗リトライ時 (§30) はページ抜粋を半減して再送する

// 既存live経路との後方互換配線はこのadapterだけに閉じ込める。
// SearchFetchResearchProvider本体はGoogleAIClientを生成せず、責務別interfaceだけに依存する。
function createDefaultDependencies(
  instrumentation?: ProviderInstrumentation,
): SearchFetchResearchDependencies {
  const gemini = new GoogleAIClient(() => new Date(), instrumentation);
  const research: ResearchEvaluator = {
    evaluate<T>(
      request: ResearchEvaluationRequest<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      return structuredCall(
        request.buildPrompt,
        request.schema,
        request.validate,
        instrumentation,
        signal,
        request.maxAttempts,
      );
    },
  };
  return {
    parser: gemini,
    research,
    embedding: gemini,
  };
}

export interface PageFetchResult {
  page: FetchedPage | null;
  reason: FetchFailureReason | null;
}
// 理由付き (本番) と従来形 (テストの注入) の両方を受ける
type PageFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<FetchedPage | PageFetchResult | null>;

function normalizeFetchResult(
  value: FetchedPage | PageFetchResult | null,
): PageFetchResult {
  if (value === null) return { page: null, reason: "blocked_or_empty" };
  return "page" in value ? value : { page: value, reason: null };
}

// 検索結果の上位に自動収集禁止サイトが並ぶと、フェッチャが全件を拒否して
// Web Evidence が 0 件になる。denylist と fetcher の HTTPS 制約を検索段階でも
// 適用し、後順位の取得可能な公開ページへ進む (#514 / #297)。
function isFetchCandidate(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !isFetchDenylisted(parsed);
  } catch {
    return false;
  }
}

// モデル出力の findings (短縮 rid / ページ番号参照 #126) を provider 契約
// (GroundedCandidateInvestigation.findings: requirementId / sourceUrls) へ復元する。
// - 未知/重複 rid、範囲外・非整数pageは部分除去せず結果全体をinvalidにする
// - 呼出し元のcandidate provider retry後もinvalidならpipelineが全未解決条件をunknownにする
// - URLの重複だけは参照先を変えないため決定的に除去する
export function restoreFindings(
  findings: ModelInvestigation["findings"],
  ridToRequirementId: Map<string, string>,
  pageUrls: string[],
): GroundedCandidateInvestigation["findings"] {
  const restored: GroundedCandidateInvestigation["findings"] = [];
  const seenRequirementIds = new Set<string>();
  for (const f of findings) {
    const requirementId = ridToRequirementId.get(f.rid);
    if (!requirementId) {
      throw new Error(
        "structured output reference invalid: unknown_requirement",
      );
    }
    if (seenRequirementIds.has(requirementId)) {
      throw new Error(
        "structured output reference invalid: duplicate_requirement",
      );
    }
    // 未知pageだけを除いて評価を温存すると、捏造参照を実在参照で隠せる。
    // 1件でも範囲外なら結果全体を破棄する。
    if (
      f.sourcePages.some((page) =>
        !Number.isInteger(page) || page < 1 || page > pageUrls.length
      )
    ) {
      throw new Error("structured output reference invalid: unknown_page");
    }
    const sourceUrls = [
      ...new Set(
        f.sourcePages.map((page) => pageUrls[page - 1]),
      ),
    ];
    seenRequirementIds.add(requirementId);
    restored.push({
      requirementId,
      state: f.state,
      confidence: f.confidence,
      explanation: f.explanation,
      sourceUrls,
      claims: f.claims.map((c) => ({
        key: c.key,
        value: c.value,
        rawText: c.rawText,
      })),
    });
  }
  return restored;
}

// 検索 query はコード側テンプレートで生成する (§5.4 Hard Rule 8 / 2026-08-15 改訂)
export function buildQueries(input: CandidateInvestigationInput): string[] {
  const name = input.place.name;
  // 住所から市区町村を抜いて同名店舗の取り違えを減らす (§5.4)
  const city =
    input.place.address.match(/(?:都|道|府|県)(.+?[市区町村])/)?.[1] ?? "";
  const queries = [
    `${name} ${city} 公式 営業時間 支払い`.trim(),
    `${name} ${city} 口コミ 雰囲気`.trim(),
  ];
  const kinds = new Set(input.requirements.map((r) => r.kind));
  // Geoapify/OSM に無い情報を Web Research で拾うための補助 query。
  // 複数の不足 kind があっても else-if で捨てず、1 本へまとめる (§5.4 最大3 query)。
  const focusTerms = [
    kinds.has("budget") ? "予算 料金 コース" : null,
    kinds.has("payment") ? "クレジットカード 支払い方法" : null,
    kinds.has("reservation") ? "個室 予約" : null,
    kinds.has("party_size") ? "席数 人数 個室" : null,
    kinds.has("dietary") ? "メニュー アレルギー" : null,
    kinds.has("access") ? "アクセス 駅" : null,
  ].filter((term): term is string => term !== null);
  if (focusTerms.length > 0) {
    queries.push(`${name} ${city} ${focusTerms.join(" ")}`.trim());
  }
  return queries.slice(0, MAX_QUERIES);
}

export class SearchFetchResearchProvider implements AIProvider {
  private readonly serper: SerperSearchProvider;
  private readonly parser: RequirementParser;
  private readonly research: ResearchEvaluator;
  private readonly embedding: EmbeddingProvider;

  constructor(
    private readonly fetchPage: PageFetcher = fetchPageTextWithReason,
    private readonly instrumentation?: ProviderInstrumentation,
    dependencies: SearchFetchResearchDependencies = createDefaultDependencies(
      instrumentation,
    ),
  ) {
    this.serper = new SerperSearchProvider(instrumentation);
    this.parser = dependencies.parser;
    this.research = dependencies.research;
    this.embedding = dependencies.embedding;
  }

  parseRequirements(
    query: string,
    signal?: AbortSignal,
  ): Promise<ParsedRequirements> {
    return this.parser.parseRequirements(query, signal); // 検索ツール不要の経路
  }

  embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embedding.embed(texts, signal);
  }

  async investigateCandidate(
    input: CandidateInvestigationInput,
    signal?: AbortSignal,
  ): Promise<GroundedCandidateInvestigation> {
    // 1. 検索 (テンプレート query、最大 3)
    const queries = buildQueries(input);
    const serpResults = (
      await Promise.all(
        queries.map((q) => this.serper.search(q, 5, signal).catch(() => [])),
      )
    ).flat();

    // 2. URL を重複排除して上位 3 件を fetch (§5.4 制約)
    const seen = new Set<string>();
    const candidateUrls = serpResults
      .filter((r) => {
        if (!isFetchCandidate(r.url)) return false;
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      })
      .slice(0, MAX_FETCH_URLS + 2); // fetch 失敗に備え少し多めに候補を持つ

    // 並列 fetch (直列だと 3×10 秒で候補 timeout の主因になる)。成功した先頭 3 件を使う
    const fetched = (await Promise.all(
      candidateUrls.map((r) => this.fetchPageWithMetric(r.url, signal)),
    )).map(normalizeFetchResult);
    const pages: FetchedPage[] = fetched
      .map((f) => f.page)
      .filter((p): p is FetchedPage => p !== null)
      .slice(0, MAX_FETCH_URLS);
    const titleByUrl = new Map(serpResults.map((r) => [r.url, r.title]));
    // Web Research の歩留まり (#514)。件数と理由分類だけを残す (§34)
    const fetchFailures: Record<string, number> = {};
    for (const f of fetched) {
      if (f.page || !f.reason) continue;
      fetchFailures[f.reason] = (fetchFailures[f.reason] ?? 0) + 1;
    }
    const diagnostics = {
      serperResults: serpResults.length,
      fetchAttempted: candidateUrls.length,
      fetchSucceeded: fetched.filter((f) => f.page !== null).length,
      fetchFailures,
    };

    if (pages.length === 0) {
      // ページが 1 件も取れなければ全条件 unknown (§12 Critical Rule: 推測で match しない)
      return {
        summary:
          `${input.place.name} について確認できる公開ページを取得できませんでした。`,
        searchQueries: queries,
        diagnostics,
        citations: [],
        findings: input.requirements.map((r) => ({
          requirementId: r.id,
          state: "unknown" as const,
          confidence: 0,
          explanation: "公開情報を取得できなかったため不明です",
          sourceUrls: [],
          claims: [],
        })),
      };
    }

    // 3. Gemini (検索なし) で claim 抽出・条件評価
    // requirement は短縮 rid (r1..rN) で渡す (UUID の入出力トークン削減 #126)
    const ridToRequirementId = new Map(
      input.requirements.map((r, i) => [`r${i + 1}`, r.id]),
    );
    const requirementsText = input.requirements
      .map((r, i) =>
        `- rid=r${i + 1} [${r.kind}/${r.priority}] ${r.normalizedText}`
      )
      .join("\n");
    // ページ本文は requirement 連動のキーワード窓抽出でトークン削減 (relevance.ts)
    const keywords = keywordsForKinds(input.requirements.map((r) => r.kind));
    const excerpts = pages.map((p) => ({
      url: p.url,
      text: extractRelevantText(p.text, keywords),
    }));
    const pagesTextOf = (limit?: number) =>
      excerpts
        .map((p, i) =>
          `【ページ${i + 1}】URL: ${p.url}\n${
            limit ? p.text.slice(0, limit) : p.text
          }`
        )
        .join("\n\n----\n\n");
    const pagesText = pagesTextOf();
    const knownClaims = compactKnownClaims(input.knownClaims);
    const knownClaimsText = knownClaims.length > 0
      ? JSON.stringify(knownClaims)
      : "なし";

    const value = await this.research.evaluate({
      buildPrompt: (prevError) =>
        [
          "あなたはOISI対象を調査する OSINT アナリストです。",
          `対象domain: ${
            input.place.domain ?? "unknown"
          }（unknownは推測しない）`,
          `対象: ${input.place.name} (${input.place.address})`,
          "以下の「実際に取得した公開ページの本文」だけを根拠として、Requirements を評価してください。",
          requirementsText,
          `既に得られている構造化情報: ${knownClaimsText}`,
          "ルール:",
          "- 根拠は与えたページ本文のみ。ページに書かれていないことは推測せず state=unknown",
          "- rid は渡されたものをそのまま返す",
          `- sourcePages には根拠にしたページ番号のみを入れる (1〜${pages.length} の整数)`,
          "- 食い違う情報は一方へ丸めず、両方を claims として残す",
          "- claims は上記 Requirements の評価に関係するものだけを返す",
          "- claim.value は次の正規形を厳守する:",
          "  - budget_dinner: 円単位の数値 { min: number, max: number }。単一額なら min=max",
          "  - time_limit: 分単位の正数。明記された「時間制限なし」は null",
          "  - genre: 料理ジャンル文字列の配列",
          "  - opening_hours: HH:MM-HH:MM、closed_days: 文字列または文字列配列",
          "  - card_accepted / reservation / private_room: boolean、capacity: 正数、noise_level: quiet / moderate / loud",
          "  - non_smoking / wifi_available / child_friendly: boolean",
          "  - nearest_station_walk_minutes: 公開情報に明記された最寄り駅からの0以上の整数分。座標から推測しない",
          "  - category: ドメインに依存しないカテゴリ文字列の配列",
          "  - price_range: {min, max, currency(ISO 4217 3文字), unit(per_person/per_night/per_hour/per_day/flat)}。通貨・単位を換算しない",
          "  - amenities: 明記された設備・提供物の文字列配列",
          "  - lodging.room_type / lodging.check_in_time / lodging.check_out_time: 宿泊情報に明記された値だけ",
          "  - rental_space.equipment: レンタルスペースに明記された設備の文字列配列",
          "  - 対象domainに該当しないnamespaced claimは返さず、情報が無い条件はunknownにする",
          "- 対象と別の対象の情報を混同しない",
          "- summary は120字以内、explanation は80字以内、rawText は30字以内。必ず日本語",
          prevError
            ? `前回の出力は検証に失敗しました。修正してください: ${prevError}`
            : "",
          "----",
          prevError ? pagesTextOf(RETRY_PAGE_CHARS) : pagesText,
        ].filter(Boolean).join("\n"),
      schema: INVESTIGATION_SCHEMA,
      validate: (raw) => modelInvestigationSchema.safeParse(raw),
    }, signal);

    // citation = 実際に fetch できた URL (§5: モデル生成 URL を信用しない)。
    // findings は rid / ページ番号を UUID / URL へ復元して返す (#126)
    const findings = restoreFindings(
      value.findings,
      ridToRequirementId,
      pages.map((p) => p.url),
    );
    return {
      summary: value.summary,
      searchQueries: queries,
      diagnostics,
      citations: pages.map((p) => ({
        url: p.url,
        title: titleByUrl.get(p.url) ?? null,
      })),
      findings,
    };
  }

  private async fetchPageWithMetric(
    url: string,
    signal?: AbortSignal,
  ): Promise<FetchedPage | PageFetchResult | null> {
    const started = Date.now();
    let outcome: "ok" | "error" = "ok";
    try {
      return await this.fetchPage(url, signal);
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      this.instrumentation?.onMetric({
        provider: "fetch",
        operation: "page_fetch",
        durationMs: Date.now() - started,
        retryCount: 0,
        outcome,
      });
    }
  }
}
