import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildGroupTasteVectorCacheKey,
  composeGroupTasteVector,
  type CurrentMemberTasteProfile,
  GROUP_TASTE_ALGORITHM_VERSION,
  type GroupTasteCompositionInput,
  isGroupTasteVectorCacheValid,
  toPlaceVectorCandidateSearchInput,
} from "../functions/_shared/group_taste.ts";
import { EMBEDDING_DIMENSION } from "../functions/_shared/embedding_validation.ts";

const vector = (first: number, second = 0): number[] => {
  const values = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  values[0] = first;
  values[1] = second;
  return values;
};

const profile = (
  memberId: string,
  values: number[],
  sourceProfileVersion = "profile-v1",
  attributeKey = "quiet",
): CurrentMemberTasteProfile => ({
  memberId,
  attributeKey,
  vector: values,
  modelVersion: "taste-vector-v1",
  sourceProfileVersion,
});

const input = (
  members: GroupTasteCompositionInput["members"],
  overrides: Partial<GroupTasteCompositionInput> = {},
): GroupTasteCompositionInput => ({
  members,
  dominanceCap: 0.8,
  ...overrides,
});

Deno.test("composeGroupTasteVector: current member vectorを同じ属性・model内で重み付き合成する", async () => {
  const result = await composeGroupTasteVector(input([
    { profile: profile("member-a", vector(1)), weight: 3 },
    { profile: profile("member-b", vector(0, 1)), weight: 1 },
  ]));

  assert(result !== null);
  assertEquals(result.attributeKey, "quiet");
  assertEquals(result.algorithmVersion, GROUP_TASTE_ALGORITHM_VERSION);
  assertEquals(result.modelVersion, "taste-vector-v1");
  assertEquals(result.vector.length, EMBEDDING_DIMENSION);
  assertEquals(result.vector[0], 0.75);
  assertEquals(result.vector[1], 0.25);
  assertEquals(result.contributions.map((entry) => entry.memberId), [
    "member-a",
    "member-b",
  ]);
  assertEquals(result.weights.map((entry) => entry.effectiveWeight), [
    0.75,
    0.25,
  ]);
  assert(result.vector.every((value) => Number.isFinite(value)));
});

Deno.test("composeGroupTasteVector: member取得順に依存せず、source/weight/algorithmを再現可能にする", async () => {
  const forward = input([
    { profile: profile("member-a", vector(1)), weight: 1 },
    { profile: profile("member-b", vector(0, 1), "profile-v2"), weight: 1 },
  ], { dominanceCap: 0.5 });
  const reverse = { ...forward, members: [...forward.members].reverse() };
  const left = await composeGroupTasteVector(forward);
  const right = await composeGroupTasteVector(reverse);

  assert(left !== null);
  assert(right !== null);
  assertEquals(right.vector, left.vector);
  assertEquals(right.contributions, left.contributions);
  assertEquals(right.sourceProfileVersion, left.sourceProfileVersion);
  assertEquals(right.cacheKey, left.cacheKey);
  assert(left.sourceProfileVersion.includes("profile-v2"));
});

Deno.test("composeGroupTasteVector: 一人の極端なweightをdominance capで制限する", async () => {
  const result = await composeGroupTasteVector(input([
    { profile: profile("member-a", vector(1)), weight: 100 },
    { profile: profile("member-b", vector(0, 1)), weight: 1 },
    { profile: profile("member-c", vector(0, 0)), weight: 1 },
  ], { dominanceCap: 0.5 }));

  assert(result !== null);
  assertEquals(result.weights.map((entry) => entry.effectiveWeight), [
    0.5,
    0.25,
    0.25,
  ]);
  assertEquals(result.vector[0], 0.5);
  assertEquals(result.vector[1], 0.25);
  assertEquals(
    result.weights.every((entry) => entry.effectiveWeight <= 0.5),
    true,
  );
  assertEquals(
    result.weights.reduce((sum, entry) => sum + entry.effectiveWeight, 0),
    1,
  );
});

Deno.test("composeGroupTasteVector: hard constraintはvectorへ混ぜず、候補filter境界へ別渡しする", async () => {
  const base = input([
    { profile: profile("member-a", vector(1)), weight: 1 },
    { profile: profile("member-b", vector(0, 1)), weight: 1 },
  ], { dominanceCap: 0.5 });
  const withConstraint = await composeGroupTasteVector({
    ...base,
    hardConstraints: { requirementIds: ["req-dietary", "req-dietary"] },
  });
  const withoutConstraint = await composeGroupTasteVector(base);

  assert(withConstraint !== null);
  assert(withoutConstraint !== null);
  assertEquals(withConstraint.vector, withoutConstraint.vector);
  assertEquals(withConstraint.hardConstraints, {
    requirementIds: ["req-dietary"],
  });
  const query = toPlaceVectorCandidateSearchInput(withConstraint);
  assert(query !== null);
  assertEquals(query.queryEmbedding, withConstraint.vector);
  assertEquals(query.hardConstraints, { requirementIds: ["req-dietary"] });
});

Deno.test("composeGroupTasteVector: unknown/health/mixed model・属性はfail-closed", async () => {
  const baseMember = { profile: profile("member-a", vector(1)), weight: 1 };
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: { ...baseMember.profile, attributeKey: "health" }, weight: 1 },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      {
        profile: { ...baseMember.profile, attributeKey: "unknown" },
        weight: 1,
      },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      baseMember,
      {
        profile: {
          ...profile("member-b", vector(0, 1)),
          modelVersion: "taste-vector-v2",
        },
        weight: 1,
      },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      baseMember,
      {
        profile: {
          ...profile("member-b", vector(0, 1)),
          attributeKey: "value",
        },
        weight: 1,
      },
    ])),
    null,
  );
});

Deno.test("composeGroupTasteVector: 次元・非finite・version・weight・cap不正を補完しない", async () => {
  const base = profile("member-a", vector(1));
  const invalidDimension = { ...base, vector: base.vector.slice(0, -1) };
  const invalidFinite = [...base.vector];
  invalidFinite[3] = Number.NaN;

  assertEquals(
    await composeGroupTasteVector(input([
      { profile: invalidDimension, weight: 1 },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: { ...base, vector: invalidFinite }, weight: 1 },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: { ...base, sourceProfileVersion: "profile:raw" }, weight: 1 },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: base, weight: Number.NaN },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: base, weight: -1 },
    ])),
    null,
  );
  assertEquals(
    await composeGroupTasteVector(input([
      { profile: base, weight: 1 },
    ], { dominanceCap: 0.4 })),
    null,
  );
});

Deno.test("group taste cache: source profile/vector/weight/algorithm変更を無効化する", async () => {
  const original = input([
    { profile: profile("member-a", vector(1)), weight: 1 },
    { profile: profile("member-b", vector(0, 1)), weight: 1 },
  ], { dominanceCap: 0.5 });
  const composed = await composeGroupTasteVector(original);
  assert(composed !== null);
  assert(/^group-taste:group-taste-v1:[0-9a-f]{64}$/.test(composed.cacheKey));
  assertEquals(
    await buildGroupTasteVectorCacheKey(original),
    composed.cacheKey,
  );
  assertEquals(await isGroupTasteVectorCacheValid(composed, original), true);

  const sourceChanged = {
    ...original,
    members: original.members.map((member, index) =>
      index === 0
        ? {
          ...member,
          profile: { ...member.profile, sourceProfileVersion: "profile-v2" },
        }
        : member
    ),
  };
  const vectorChanged = {
    ...original,
    members: original.members.map((member, index) =>
      index === 0
        ? { ...member, profile: { ...member.profile, vector: vector(0.5) } }
        : member
    ),
  };
  const weightChanged = {
    ...original,
    members: original.members.map((member, index) =>
      index === 0 ? { ...member, weight: 2 } : member
    ),
  };
  assertNotEquals(
    await buildGroupTasteVectorCacheKey(sourceChanged),
    composed.cacheKey,
  );
  assertNotEquals(
    await buildGroupTasteVectorCacheKey(vectorChanged),
    composed.cacheKey,
  );
  assertNotEquals(
    await buildGroupTasteVectorCacheKey(weightChanged),
    composed.cacheKey,
  );
  assertEquals(
    await isGroupTasteVectorCacheValid(composed, sourceChanged),
    false,
  );
  assertEquals(
    await isGroupTasteVectorCacheValid(composed, vectorChanged),
    false,
  );
  assertEquals(
    await isGroupTasteVectorCacheValid(composed, weightChanged),
    false,
  );
  assertEquals(
    await isGroupTasteVectorCacheValid(
      {
        ...composed,
        algorithmVersion:
          "group-taste-unknown" as typeof composed.algorithmVersion,
      },
      original,
    ),
    false,
  );
});

Deno.test("toPlaceVectorCandidateSearchInput: output vectorを再検証し、改変されたcacheを拒否する", async () => {
  const composed = await composeGroupTasteVector(input([
    { profile: profile("member-a", vector(1)), weight: 1 },
    { profile: profile("member-b", vector(0, 1)), weight: 1 },
  ], { dominanceCap: 0.5 }));
  assert(composed !== null);
  const invalid = { ...composed, vector: [...composed.vector] };
  invalid.vector[10] = Infinity;
  assertEquals(toPlaceVectorCandidateSearchInput(invalid), null);
  assertEquals(toPlaceVectorCandidateSearchInput(null), null);
});
