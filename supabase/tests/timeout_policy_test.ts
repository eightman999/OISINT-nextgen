import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
  CANDIDATE_PROVIDER_MAX_ATTEMPTS,
  CREATE_DATABASE_MARGIN_MS,
  CREATE_EMBEDDING_TIMEOUT_MS,
  CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS,
  CREATE_PROVIDER_MAX_ATTEMPTS,
  EDGE_TIMEOUT_POLICY,
  RERANK_DATABASE_MARGIN_MS,
} from "../functions/_shared/timeout_policy.ts";

const createSource = await Deno.readTextFile(
  new URL("../functions/create-investigation/index.ts", import.meta.url),
);
const pipelineSource = await Deno.readTextFile(
  new URL("../functions/_shared/pipeline.ts", import.meta.url),
);

Deno.test("create provider deadlineは10秒以下で同期transportは5秒を使わない", () => {
  assert(CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS <= 10_000);
  assert(CREATE_EMBEDDING_TIMEOUT_MS <= 10_000);
  assert(EDGE_TIMEOUT_POLICY.synchronousCreate > EDGE_TIMEOUT_POLICY.receipt);
  assertEquals(CREATE_PROVIDER_MAX_ATTEMPTS, 1);
  assertEquals(EDGE_TIMEOUT_POLICY.synchronousCreate, 10_000);
  assertEquals(
    CREATE_PROVIDER_ATTEMPT_TIMEOUT_MS + CREATE_EMBEDDING_TIMEOUT_MS +
      CREATE_DATABASE_MARGIN_MS,
    EDGE_TIMEOUT_POLICY.synchronousCreate,
  );
  assertStringIncludes(
    createSource,
    "ai.parseRequirements(query, signal)",
  );
  assertStringIncludes(
    createSource,
    "ai.embed([parsed.normalizedQuery], signal)",
  );
  assertStringIncludes(createSource, '"begin_investigation_creation_step"');
  assertStringIncludes(
    createSource,
    '"save_investigation_creation_parse_checkpoint"',
  );
});

Deno.test("requirement_added内部最大時間はEdge budgetより短い", () => {
  const providerAndDatabaseBudget = CANDIDATE_PROVIDER_ATTEMPT_TIMEOUT_MS *
      CANDIDATE_PROVIDER_MAX_ATTEMPTS + RERANK_DATABASE_MARGIN_MS;
  assert(providerAndDatabaseBudget < EDGE_TIMEOUT_POLICY.synchronousRerank);
  assertStringIncludes(
    pipelineSource,
    "attempt < CANDIDATE_PROVIDER_MAX_ATTEMPTS",
  );
  assertStringIncludes(
    pipelineSource,
    "ai.investigateCandidate(input, signal)",
  );
});
