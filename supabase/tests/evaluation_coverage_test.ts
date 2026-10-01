// run-investigation の候補再入判定 (#312)。評価が1行でもある、ではなく
// candidate × current requirement の全組が揃った時だけ完了とする。
import { assertEquals } from "@std/assert";
import { pendingCandidateIdsForCoverage } from "../functions/_shared/evaluation_coverage.ts";

Deno.test("coverage: 条件単位の途中結果があっても不足requirementの候補はpending", () => {
  const candidates = ["c1", "c2"];
  const requirements = ["r1", "r2", "r3"];
  const interruptedRows = [
    { candidateId: "c1", requirementId: "r1" },
    { candidateId: "c1", requirementId: "r2" },
    { candidateId: "c2", requirementId: "r1" },
    { candidateId: "c2", requirementId: "r2" },
    { candidateId: "c2", requirementId: "r3" },
  ];
  assertEquals(
    pendingCandidateIdsForCoverage(candidates, requirements, interruptedRows),
    ["c1"],
  );

  const resumedRows = [
    ...interruptedRows,
    { candidateId: "c1", requirementId: "r3" },
  ];
  assertEquals(
    pendingCandidateIdsForCoverage(candidates, requirements, resumedRows),
    [],
  );
});

Deno.test("coverage: 他候補・削除済み条件・重複行はcoverageを水増ししない", () => {
  assertEquals(
    pendingCandidateIdsForCoverage(
      ["c1"],
      ["r1", "r2"],
      [
        { candidateId: "c1", requirementId: "r1" },
        { candidateId: "c1", requirementId: "r1" },
        { candidateId: "c1", requirementId: "deleted-r3" },
        { candidateId: "other", requirementId: "r2" },
      ],
    ),
    ["c1"],
  );
});

Deno.test("coverage: requirement 0件なら候補はpendingにしない", () => {
  assertEquals(
    pendingCandidateIdsForCoverage(["c1", "c2"], [], []),
    [],
  );
});
