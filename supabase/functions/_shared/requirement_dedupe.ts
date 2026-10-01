import {
  type ParsedRequirements,
  parsedRequirementsSchema,
} from "./validation.ts";

type ParsedRequirement = ParsedRequirements["requirements"][number];

// 同一条件の反復で weight / priority が増幅しないよう、最初の1件をそのまま採用する。
// NFKC で全角半角を揃え、英字大小・空白・代表的な和文記号の揺れだけを吸収する。
export function normalizeRequirementDedupeText(text: string): string {
  return text
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replaceAll(/[\s\u3000]+/g, " ")
    .replaceAll(/[、，]/g, ",")
    .replaceAll(/[。．]/g, ".")
    .replaceAll(/[・･]/g, "·")
    .replaceAll(/[「」『』]/g, '"')
    .replaceAll(/[“”]/g, '"')
    .replaceAll(/[‘’]/g, "'");
}

export function dedupeRequirements(
  requirements: readonly ParsedRequirement[],
): ParsedRequirement[] {
  const seen = new Set<string>();
  const deduped: ParsedRequirement[] = [];

  for (const requirement of requirements) {
    const key = `${requirement.kind}\u0000${
      normalizeRequirementDedupeText(requirement.normalizedText)
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(requirement);
  }

  return deduped;
}

// provider に依存しない共通入口用。Zod の shape 検証が成功した後にのみ、
// 決定論的な意味処理として重複条件を統合する。
export function validateAndDedupeParsedRequirements(raw: unknown) {
  const parsed = parsedRequirementsSchema.safeParse(raw);
  if (!parsed.success) return parsed;

  return {
    ...parsed,
    data: {
      ...parsed.data,
      requirements: dedupeRequirements(parsed.data.requirements),
    },
  };
}
