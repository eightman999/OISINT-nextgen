import { assertEquals } from "@std/assert";
import { corsHeaders, handleOptions } from "../functions/_shared/db.ts";

Deno.test("CORS: 本番Originだけを反射しVaryを付ける", () => {
  const headers = corsHeaders("https://oisint.com");
  assertEquals(headers["Access-Control-Allow-Origin"], "https://oisint.com");
  assertEquals(headers.Vary, "Origin");
});

Deno.test("CORS: 未許可Originを反射しない", () => {
  const headers = corsHeaders("https://attacker.example");
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  assertEquals(headers.Vary, "Origin");
});

Deno.test("CORS: OPTIONSでも同じallow-listを使う", async () => {
  const allowed = handleOptions(
    new Request("https://edge.example", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:8081" },
    }),
  );
  assertEquals(allowed?.status, 204);
  assertEquals(
    allowed?.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:8081",
  );

  const denied = handleOptions(
    new Request("https://edge.example", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    }),
  );
  assertEquals(denied?.headers.get("Access-Control-Allow-Origin"), null);
  await allowed?.body?.cancel();
  await denied?.body?.cancel();
});
