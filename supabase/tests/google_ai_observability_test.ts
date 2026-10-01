// #514 切り分け: Structured Output の途中切断と Zod 失敗を、
// 本文を漏らさずに観測できることの検証 (§34)。
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  describeInteractionCompletion,
  zodIssueDigest,
} from "../functions/_shared/providers/google_ai.ts";

Deno.test("describeInteractionCompletion: 正常完了は truncated=false", () => {
  const result = describeInteractionCompletion(
    { status: "completed", usage: { output_tokens: 1200 } },
    16384,
  );
  assertEquals(result, {
    status: "completed",
    reason: "none",
    truncated: false,
  });
});

Deno.test("describeInteractionCompletion: incomplete / max_output_tokens を切断として拾う", () => {
  assert(
    describeInteractionCompletion({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }, 16384).truncated,
  );
  // Gemini generateContent 形 (finishReason=MAX_TOKENS) でも拾う
  assert(
    describeInteractionCompletion({
      candidates: [{ finishReason: "MAX_TOKENS" }],
    }, 16384).truncated,
  );
  assertEquals(
    describeInteractionCompletion({
      candidates: [{ finishReason: "MAX_TOKENS" }],
    }, 16384).reason,
    "MAX_TOKENS",
  );
});

Deno.test("describeInteractionCompletion: 出力トークンが上限到達なら二次シグナルで切断扱い", () => {
  assert(
    describeInteractionCompletion(
      { status: "completed", usage: { candidatesTokenCount: 8192 } },
      8192,
    ).truncated,
  );
  assertEquals(
    describeInteractionCompletion(
      { status: "completed", usage: { candidatesTokenCount: 8191 } },
      8192,
    ).truncated,
    false,
  );
});

Deno.test("describeInteractionCompletion: 未知形状でも例外にせず unknown を返す", () => {
  assertEquals(describeInteractionCompletion(null, 16384), {
    status: "unknown",
    reason: "none",
    truncated: false,
  });
});

Deno.test("zodIssueDigest: path と code だけを返し、受信値をログへ出さない", () => {
  const schema = z.object({
    findings: z.array(z.object({ requirementId: z.string() })),
  });
  const parsed = schema.safeParse({
    findings: [{ requirementId: 12345 }],
  });
  assert(!parsed.success);
  const digest = zodIssueDigest(parsed.error);
  assertEquals(digest, "findings.0.requirementId:invalid_type");
  assertEquals(digest.includes("12345"), false);
});

Deno.test("zodIssueDigest: issue が多い場合は先頭 5 件と残数だけにする", () => {
  const schema = z.object({
    a: z.string(),
    b: z.string(),
    c: z.string(),
    d: z.string(),
    e: z.string(),
    f: z.string(),
    g: z.string(),
  });
  const parsed = schema.safeParse({});
  assert(!parsed.success);
  const digest = zodIssueDigest(parsed.error);
  assertEquals(digest.split(",").length, 6);
  assert(digest.endsWith(",+2"));
});
