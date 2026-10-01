// 決定論 Pre-Rank provider (issue #552)。
// 役割は 2 つ:
//   1. PRE_RANK_PROVIDER の既定値。外部 API を一切呼ばず、コスト 0 で pre-rank する
//   2. AI provider (OpenRouter 等) が timeout / invalid JSON / empty を返したときの fallback
// 判定本体は prerank.ts の純関数。ここは Provider interface への薄い適合だけを行う。
import { deterministicPreRank } from "../prerank.ts";
import type { PreRankCandidate, PreRankRequirement } from "../prerank.ts";
import type { PreRankOutcome, PreRankProvider } from "./types.ts";

export class DeterministicPreRankProvider implements PreRankProvider {
  readonly id = "deterministic";

  preRank(
    candidates: PreRankCandidate[],
    requirements: PreRankRequirement[],
  ): Promise<PreRankOutcome> {
    const started = Date.now();
    const results = deterministicPreRank(candidates, requirements);
    return Promise.resolve({
      provider: this.id,
      results,
      acceptedIds: [],
      rejectedIds: [],
      fallbackReason: null,
      attempts: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      latencyMs: Date.now() - started,
    });
  }
}

// mock モード用。外部 API 非依存という点では deterministic と同じだが、
// DATA_PROVIDER_MODE=mock で AI provider が選ばれないことを型で明示するために分ける
// (§5.4 Fallback: mock で全フローが完走する状態を常に保つ)。
export class MockPreRankProvider implements PreRankProvider {
  readonly id = "mock";

  preRank(
    candidates: PreRankCandidate[],
    requirements: PreRankRequirement[],
  ): Promise<PreRankOutcome> {
    const started = Date.now();
    return Promise.resolve({
      provider: this.id,
      results: deterministicPreRank(candidates, requirements),
      acceptedIds: [],
      rejectedIds: [],
      fallbackReason: null,
      attempts: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      latencyMs: Date.now() - started,
    });
  }
}
