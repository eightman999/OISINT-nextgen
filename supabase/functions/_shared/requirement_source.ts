// Requirement の決定論評価に使う原文が、immutable な investigations.raw_query に
// 実在する同一意図の記述かを検証する。AI が text / normalizedText の極性や数値を
// 書き換えても、Evidence から match / partial / mismatch を確定しないための境界。
import {
  type BudgetConstraint,
  normalizeBudgetRequirement,
  normalizeTimeRequirement,
} from "./requirement_matching.ts";
import {
  parseBudgetRequirement,
  parsePartySizeRequirement,
  parsePaymentRequirement,
  parseReservationRequirement,
  parseStructuredFilterRequirement,
  type StructuredFilterRequirementIntent,
} from "./facts.ts";

export const SOURCE_ATTESTED_REQUIREMENT_KINDS = new Set([
  "payment",
  "budget",
  "reservation",
  "party_size",
  "time",
]);

const HARD_CLAUSE_SEPARATOR = /[。．.!！?？、,，;；\n\r]+/;
// Homeのchipはraw_queryへ ` / ` 区切りで追加される。ユーザーが通常の
// スラッシュを入力した場合まで分割しないよう、両側空白があるUI delimiterだけを扱う。
const STRUCTURED_FILTER_CLAUSE_SEPARATOR =
  /[。．.!！?？、,，;；\n\r]+|\s+\/\s+/;
const NO_CONSTRAINT_PATTERN =
  /(?:未定|不問|問わない|こだわらない|おまかせ|指定(?:は)?(?:なし|無し)|指定しない|何人でも(?:よい|いい|可)?|どちらでも(?:よい|いい|可)?|何でも(?:よい|いい|可)?|上限(?:なし|無し)|下限(?:なし|無し)|制限(?:なし|無し)|条件(?:は)?(?:なし|無し))/;
const GENERIC_NO_CONSTRAINT_CLAUSE =
  /^(?:条件(?:は)?(?:なし|無し)|おまかせ|指定(?:は)?(?:なし|無し)|指定しない|何でも(?:よい|いい|可)?|どちらでも(?:よい|いい|可)?|上限(?:なし|無し)|下限(?:なし|無し)|制限(?:なし|無し))$/;
const NO_CONSTRAINT_DOMAIN_PATTERNS: Readonly<Record<string, RegExp>> = {
  payment: /クレジットカード|クレカ|カード|現金|支払|決済/,
  reservation: /予約|個室|席種|座席/,
  party_size: /人数|参加者|メンバー|同行者|グループ|何人/,
  budget: /予算|金額|料金|価格|費用|値段|単価|上限|下限/,
  time: /時間|日時|日程|時間帯|時間指定|朝|昼|夜|ランチ|ディナー|深夜/,
};
// normalizeTimeRequirement と同じ入力境界のうち、明示範囲を raw query の
// 「時間条件を含む節」として検出する。値の妥当性・原文との同一性は後段の
// timeFingerprint / fingerprintSourceClause で検証するため、ここでは字句だけ拾う。
const EXPLICIT_TIME_RANGE_PATTERN =
  /(?:翌)?(?:午前|午後)?\d{1,2}(?::\d{2}|時(?:\d{1,2}分|半)?)(?:から|[-−‐‑‒–—〜～~])(?:翌)?(?:午前|午後)?\d{1,2}(?::\d{2}|時(?:\d{1,2}分|半)?)/;
function expandTenThousands(text: string): string {
  return text.replace(
    /([0-9]+(?:\.[0-9]+)?)万(?=円)/g,
    (_match, raw) => String(Math.round(Number(raw) * 10_000)),
  );
}
function canonicalSourceText(text: string): string {
  return expandTenThousands(text.normalize("NFKC"))
    .replace(/([0-9]),(?=[0-9]{3}(?:\D|$))/g, "$1")
    .trim()
    .replaceAll(/\s+/g, "");
}

function expressesNoConstraintIntent(text: string): boolean {
  const canonical = canonicalSourceText(text);
  if (GENERIC_NO_CONSTRAINT_CLAUSE.test(canonical)) return true;
  return NO_CONSTRAINT_PATTERN.test(canonical) &&
    Object.values(NO_CONSTRAINT_DOMAIN_PATTERNS).some((pattern) =>
      pattern.test(canonical)
    );
}

function isUnlimitedStayPreference(text: string): boolean {
  return /^(?:時間制限(?:なし|無し)|時間無制限)(?:で)?(?:ゆっくり(?:できる|したい)?|滞在(?:できる|したい)?)?$/
    .test(canonicalSourceText(text));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count++;
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

function structuredFilterFingerprint(
  text: string,
): { fingerprint: string; intent: StructuredFilterRequirementIntent } | null {
  const intent = parseStructuredFilterRequirement(text);
  if (!intent) return null;
  return {
    intent,
    fingerprint: intent.kind === "walk_limit"
      ? `walk:${intent.maxMinutes}`
      : `boolean:${intent.key}:${intent.desired}`,
  };
}

function structuredFilterDomain(
  intent: StructuredFilterRequirementIntent,
): "non_smoking" | "wifi_available" | "child_friendly" | "walk" {
  return intent.kind === "walk_limit" ? "walk" : intent.key;
}

function clauseMentionsStructuredFilterDomain(
  domain: ReturnType<typeof structuredFilterDomain>,
  text: string,
): boolean {
  const canonical = canonicalSourceText(text).toLowerCase();
  if (domain === "non_smoking") return /禁煙|喫煙/.test(canonical);
  if (domain === "wifi_available") return /wi-?fi|無線lan/.test(canonical);
  if (domain === "child_friendly") {
    return /(?:子ども|子供|子)連れ/.test(canonical);
  }
  return /徒歩[0-9]+分|駅から徒歩/.test(canonical);
}

function mentionsAnyStructuredFilter(text: string): boolean {
  return [
    "non_smoking",
    "wifi_available",
    "child_friendly",
    "walk",
  ].some((domain) =>
    clauseMentionsStructuredFilterDomain(
      domain as ReturnType<typeof structuredFilterDomain>,
      text,
    )
  );
}

function structuredFilterClauseFingerprint(
  clause: string,
  sourceText: string,
): ReturnType<typeof structuredFilterFingerprint> {
  const direct = structuredFilterFingerprint(clause);
  if (direct) return direct;
  if (!sourceText || countOccurrences(clause, sourceText) !== 1) return null;
  const offset = clause.indexOf(sourceText);
  const prefix = clause.slice(0, offset);
  const suffix = clause.slice(offset + sourceText.length);
  if (suffix !== "" || !isSafeNonRequirementContextPrefix(prefix)) return null;
  return structuredFilterFingerprint(sourceText);
}

/**
 * filter chipの決定論評価に使う原文をimmutable raw_queryへ結び付ける。
 * 同じdomainの曖昧・矛盾節が1件でもあれば、肯定節だけを選び取らずfail closedにする。
 */
export function attestStructuredFilterSourceText(input: {
  text: string;
  normalizedText: string;
  rawQuery: string;
}): string | null {
  const sourceText = canonicalSourceText(input.text);
  const source = structuredFilterFingerprint(input.text);
  const normalized = structuredFilterFingerprint(input.normalizedText);
  if (
    !sourceText || !source || !normalized ||
    source.fingerprint !== normalized.fingerprint || !input.rawQuery.trim()
  ) return null;

  const domain = structuredFilterDomain(source.intent);
  const clauses = input.rawQuery.normalize("NFKC")
    .split(STRUCTURED_FILTER_CLAUSE_SEPARATOR)
    .map((clause) => canonicalSourceText(clause))
    .filter(Boolean);
  const mentioned = clauses.filter((clause) =>
    clauseMentionsStructuredFilterDomain(domain, clause)
  );
  if (mentioned.length === 0) return null;
  const parsed = mentioned.map((clause) =>
    structuredFilterClauseFingerprint(clause, sourceText)
  );
  if (parsed.some((item) => item === null)) return null;
  const matching = mentioned.filter((clause) =>
    countOccurrences(clause, sourceText) === 1 &&
    structuredFilterClauseFingerprint(clause, sourceText)?.fingerprint ===
      source.fingerprint
  );
  if (matching.length !== 1) return null;
  const fingerprints = new Set(
    parsed.map((item) => item?.fingerprint).filter((item): item is string =>
      item !== undefined
    ),
  );
  return fingerprints.size === 1 && fingerprints.has(source.fingerprint)
    ? input.text.trim()
    : null;
}

// 「池袋で予算3000円」のような安全な場所・日付コンテキストだけを許す。
// 任意prefixを落とすと「予算不要で3000円」等が肯定へ反転するため、決定論domainや
// 否定・除外語を含むprefixは必ず拒否する。
function isSafeNonRequirementContextPrefix(prefix: string): boolean {
  if (!prefix.endsWith("で") || prefix.length > 40) return false;
  const context = prefix.slice(0, -1);
  // Positive whitelist only. An arbitrary Japanese prefix followed by 「で」
  // can encode unlimited negations (上限なしで/参加者未定で/指定なしで), so it
  // is not safe to maintain a blacklist. Permit a date plus a known area name,
  // or a conventional Japanese location suffix, and reject everything else.
  return /^(?:[0-9]{1,2}[／/][0-9]{1,2}に)?(?:池袋|新宿|渋谷|上野|銀座|秋葉原|品川|横浜|六本木|東京|大阪|京都|名古屋|札幌|福岡|神戸|仙台|広島|[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー]{1,20}(?:都|道|府|県|市|区|町|村|駅|丁目|エリア|周辺|近辺|空港))$/u
    .test(context);
}

function fingerprintSourceClause(
  kind: string,
  clause: string,
  sourceText: string,
): string | null {
  const direct = requirementIntentFingerprint(kind, clause);
  if (direct) return direct;
  if (!sourceText || countOccurrences(clause, sourceText) !== 1) return null;
  const offset = clause.indexOf(sourceText);
  const prefix = clause.slice(0, offset);
  const suffix = clause.slice(offset + sourceText.length);
  if (suffix !== "" || !isSafeNonRequirementContextPrefix(prefix)) return null;
  return requirementIntentFingerprint(kind, sourceText);
}

function budgetFingerprint(text: string): string | null {
  const canonical = canonicalSourceText(text);
  const explicit = parseBudgetRequirement(canonical);
  if (explicit) {
    if (explicit.operator === "range") {
      return `budget:range:${explicit.min}:${explicit.max}`;
    }
    if (explicit.operator === "around") {
      return "budget:around:" + explicit.amount + ":" +
        Math.round(explicit.amount * 0.2);
    }
    return `budget:${explicit.operator}:${explicit.amount}`;
  }
  const value = normalizeBudgetRequirement(canonical);
  if (!value) return null;
  return value.toleranceYen > 0
    ? `budget:around:${value.maxYen}:${value.toleranceYen}`
    : `budget:max_inclusive:${value.maxYen}`;
}

function timeFingerprint(text: string): string | null {
  const value = normalizeTimeRequirement(text);
  return value ? `time:${value.startMinute}:${value.endMinute}` : null;
}

function paymentFingerprint(text: string): string | null {
  const desired = parsePaymentRequirement(canonicalSourceText(text));
  return desired === null ? null : `payment:${desired}`;
}

function reservationFingerprint(text: string): string | null {
  const intent = parseReservationRequirement(canonicalSourceText(text));
  return intent ? `${intent.subject}:${intent.desired}` : null;
}

function partySizeFingerprint(text: string): string | null {
  const value = parsePartySizeRequirement(canonicalSourceText(text));
  return value === null ? null : `party_size:${value}`;
}

export function clauseMentionsRequirementKind(
  kind: string,
  text: string,
): boolean {
  const t = canonicalSourceText(text);
  switch (kind) {
    case "budget":
      return budgetFingerprint(t) !== null ||
        /[0-9]+(?:\.[0-9]+)?(?:万)?円|安い|安め|お手頃|手頃|リーズナブル|格安|激安|コスパ/
          .test(t);
    case "time":
      return /深夜|夜中|モーニング|朝食|朝ご飯|朝ごはん|朝|ランチ|昼食|昼ご飯|昼ごはん|お昼|昼|夕方|ディナー|夕食|晩ご飯|晩ごはん|夜/
        .test(
          t,
        ) || EXPLICIT_TIME_RANGE_PATTERN.test(t);
    case "payment":
      return /クレジットカード|クレカ|カード/.test(t);
    case "reservation":
      return /予約|個室/.test(t);
    case "party_size":
      return /[0-9]+人/.test(t);
    default:
      return false;
  }
}

export function requirementNeedsSourceAttestation(
  kind: string,
  text: string,
  normalizedText: string,
  userAddedUnclassified = false,
): boolean {
  if (SOURCE_ATTESTED_REQUIREMENT_KINDS.has(kind)) return true;
  if (
    mentionsAnyStructuredFilter(text) ||
    mentionsAnyStructuredFilter(normalizedText)
  ) return true;
  // 「時間指定なし」は時間帯の制約なしだが、「時間制限なし」は店の滞在条件を
  // 求める肯定的なsemantic requirement。両者を同じ no-constraint 扱いにしない。
  if (
    isUnlimitedStayPreference(text) &&
    isUnlimitedStayPreference(normalizedText)
  ) return false;
  // A parser-produced "other" requirement that explicitly says there is no
  // constraint must never be promoted by the semantic single-citation path.
  // Keep this wording-based gate domain-independent: models can call the same
  // intent 費用/値段/決済手段/席種/同行者/日程, so enumerating only the five
  // deterministic domain nouns leaves an open-ended kind-misclassification
  // bypass. Ordinary semantic requirements do not contain these expressions.
  if (
    expressesNoConstraintIntent(text) ||
    expressesNoConstraintIntent(normalizedText)
  ) {
    return true;
  }
  // kind=NULL is the existing authenticated user-add path. It has no immutable
  // raw-query provenance, so keep it semantic-only. A parser-produced explicit
  // `other`, however, must not hide a deterministic intent from the source gate.
  if (userAddedUnclassified) return false;
  return [...SOURCE_ATTESTED_REQUIREMENT_KINDS].some((candidateKind) =>
    clauseHasPotentialRequirementIntent(candidateKind, text) ||
    clauseHasPotentialRequirementIntent(candidateKind, normalizedText)
  );
}

function clauseHasPotentialRequirementIntent(
  kind: string,
  clause: string,
): boolean {
  const canonical = canonicalSourceText(clause);
  if (NO_CONSTRAINT_PATTERN.test(canonical)) {
    if (GENERIC_NO_CONSTRAINT_CLAUSE.test(canonical)) return true;
    const noConstraintDomainMention = NO_CONSTRAINT_DOMAIN_PATTERNS[kind];
    if (noConstraintDomainMention?.test(canonical)) return true;
  }
  if (kind === "payment") {
    return /(?:クレジットカード|クレカ|カード)(?=$|は|を|が|で|利用|払い|決済|可|不|非|しか|だけ|のみ)|現金(?=$|は|を|が|で|のみ|だけ)/
      .test(canonical);
  }
  if (kind === "reservation") {
    return /(?:予約|個室)(?=$|は|を|が|で|可|不|利|希望|し|な|有|あ|O)/
      .test(canonical);
  }
  if (kind === "party_size") {
    return /人数|参加者|メンバー|[0-9]+人/.test(canonical);
  }
  if (kind === "budget") {
    return /予算|金額|料金|価格/.test(canonical) ||
      clauseMentionsRequirementKind(kind, canonical);
  }
  if (kind !== "time") return clauseMentionsRequirementKind(kind, canonical);
  // Japanese has no spaces; use a following grammatical boundary so place or
  // cuisine words such as 朝霞市/朝鮮料理/夜景/夜行バス/ランチコース do not veto a
  // separate valid time clause. Negative/choice clauses still match the boundary.
  const token =
    "(?:深夜|夜中|モーニング|朝食|朝ご飯|朝ごはん|朝|ランチ|昼食|昼ご飯|昼ごはん|お昼|昼|夕方|ディナー|夕食|晩ご飯|晩ごはん|夜)";
  return new RegExp(
    `${token}(?:の?時間帯|営業|型|限定)?(?=$|は|を|が|に|で|の|以外|または|あるいは|や|不要|なし|無し|未定|問わない|避け|除外|嫌|無理|困る)`,
  ).test(canonical) ||
    EXPLICIT_TIME_RANGE_PATTERN.test(canonical) ||
    /(?:営業時間|時間帯|時間指定|時間)(?:は|を|が)?(?:不要|なし|無し|未定|問わない|指定なし)/
      .test(canonical);
}

export function requirementIntentFingerprint(
  kind: string,
  text: string,
): string | null {
  if (!text) return null;
  switch (kind) {
    case "budget":
      return budgetFingerprint(text);
    case "time":
      return timeFingerprint(text);
    case "payment":
      return paymentFingerprint(text);
    case "reservation":
      return reservationFingerprint(text);
    case "party_size":
      return partySizeFingerprint(text);
    default:
      return null;
  }
}

export interface RequirementSourceInput {
  kind: string;
  text: string;
  normalizedText: string;
  rawQuery: string;
}

export function inferDeterministicRequirementKind(
  text: string,
  normalizedText: string,
): string | null {
  const matches = [...SOURCE_ATTESTED_REQUIREMENT_KINDS].filter((kind) => {
    const source = requirementIntentFingerprint(kind, text);
    const normalized = requirementIntentFingerprint(kind, normalizedText);
    return source !== null && source === normalized;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function resolveRequirementSource(input: {
  storedKind: string | null;
  text: string;
  normalizedText: string;
  rawQuery: string;
}): { kind: string; originalText: string; sourceAttested: boolean } {
  if (input.storedKind === null) {
    // kind=NULLは認証済みユーザーが直接追加したRequirement。text自体が一次入力なので、
    // 原文と正規化文が同じchip intentならraw_queryに存在しなくても安全に分類できる。
    const sourceFilter = structuredFilterFingerprint(input.text);
    const normalizedFilter = structuredFilterFingerprint(input.normalizedText);
    if (
      sourceFilter && normalizedFilter &&
      sourceFilter.fingerprint === normalizedFilter.fingerprint
    ) {
      const kind = sourceFilter.intent.kind === "walk_limit"
        ? "access"
        : sourceFilter.intent.key === "non_smoking"
        ? "atmosphere"
        : "other";
      return {
        kind,
        originalText: input.text.trim(),
        sourceAttested: true,
      };
    }
    const inferredKind = inferDeterministicRequirementKind(
      input.text,
      input.normalizedText,
    );
    if (inferredKind) {
      return {
        kind: inferredKind,
        originalText: input.text.trim(),
        sourceAttested: true,
      };
    }
    const deterministicMention = requirementNeedsSourceAttestation(
      "other",
      input.text,
      input.normalizedText,
    );
    return {
      kind: "other",
      originalText: deterministicMention ? "" : input.text.trim(),
      sourceAttested: !deterministicMention,
    };
  }

  const kind = input.storedKind;
  if (
    mentionsAnyStructuredFilter(input.text) ||
    mentionsAnyStructuredFilter(input.normalizedText)
  ) {
    const originalText = attestStructuredFilterSourceText({
      text: input.text,
      normalizedText: input.normalizedText,
      rawQuery: input.rawQuery,
    }) ?? "";
    return { kind, originalText, sourceAttested: originalText !== "" };
  }
  const needsAttestation = requirementNeedsSourceAttestation(
    kind,
    input.text,
    input.normalizedText,
  );
  if (!needsAttestation) {
    return { kind, originalText: input.text.trim(), sourceAttested: true };
  }
  if (!SOURCE_ATTESTED_REQUIREMENT_KINDS.has(kind)) {
    return { kind, originalText: "", sourceAttested: false };
  }
  const originalText = attestRequirementSourceText({
    kind,
    text: input.text,
    normalizedText: input.normalizedText,
    rawQuery: input.rawQuery,
  }) ?? "";
  return { kind, originalText, sourceAttested: originalText !== "" };
}

// text の単純な部分一致だけでは採用しない。raw_query の hard clause 全体、DB text、
// normalizedText の3者が同じ一意な決定論intentを表す場合だけ、検証済み原文を返す。
export function attestRequirementSourceText(
  input: RequirementSourceInput,
): string | null {
  if (!SOURCE_ATTESTED_REQUIREMENT_KINDS.has(input.kind)) return null;
  const sourceText = canonicalSourceText(input.text);
  const rawQuery = expandTenThousands(input.rawQuery.normalize("NFKC")).replace(
    /([0-9]),(?=[0-9]{3}(?:\D|$))/g,
    "$1",
  );
  if (!sourceText || !rawQuery.trim()) return null;

  const textFingerprint = requirementIntentFingerprint(input.kind, input.text);
  const normalizedFingerprint = requirementIntentFingerprint(
    input.kind,
    input.normalizedText,
  );
  if (!textFingerprint || textFingerprint !== normalizedFingerprint) {
    return null;
  }

  const clauses = rawQuery
    .split(HARD_CLAUSE_SEPARATOR)
    .map((clause) => canonicalSourceText(clause))
    .filter(Boolean);
  const mentionedClauses = clauses.filter((clause) =>
    clauseHasPotentialRequirementIntent(input.kind, clause)
  );
  // 同kindを含む別節がnegative/ambiguous/unparseableなら、肯定節だけを選び取らない。
  if (
    mentionedClauses.length === 0 ||
    mentionedClauses.some((clause) =>
      fingerprintSourceClause(input.kind, clause, sourceText) === null
    )
  ) return null;
  const matchingClauses = clauses.filter((clause) =>
    countOccurrences(clause, sourceText) === 1 &&
    fingerprintSourceClause(input.kind, clause, sourceText) === textFingerprint
  );
  // 同じ text が複数箇所に現れる場合は、どの原文が根拠か一意に決められない。
  if (matchingClauses.length !== 1) return null;

  // 同じ query 内に同 kind の別intentがあれば、AIがどちらを選んだか証明できない。
  const queryFingerprints = new Set(
    clauses
      .map((clause) => fingerprintSourceClause(input.kind, clause, sourceText))
      .filter((value): value is string => value !== null),
  );
  if (input.kind === "reservation") {
    const subject = textFingerprint.split(":", 1)[0];
    const sameSubject = [...queryFingerprints].filter((fingerprint) =>
      fingerprint.startsWith(`${subject}:`)
    );
    if (sameSubject.length !== 1 || sameSubject[0] !== textFingerprint) {
      return null;
    }
  } else if (
    queryFingerprints.size !== 1 || !queryFingerprints.has(textFingerprint)
  ) {
    return null;
  }
  return input.text.trim();
}

export function attestedBudgetConstraint(
  input: RequirementSourceInput,
): BudgetConstraint | null {
  if (input.kind !== "budget") return null;
  const sourceText = attestRequirementSourceText(input);
  if (!sourceText) return null;
  const source = normalizeBudgetRequirement(sourceText);
  const normalized = normalizeBudgetRequirement(input.normalizedText);
  return source && normalized &&
      source.maxYen === normalized.maxYen &&
      source.toleranceYen === normalized.toleranceYen
    ? normalized
    : null;
}
