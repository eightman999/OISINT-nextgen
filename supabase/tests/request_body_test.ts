import { assertEquals, assertThrows } from "@std/assert";
import {
  readRequestBodyLimited,
  readRequestBytesLimited,
  readResponseBodyLimited,
} from "../functions/_shared/request_body.ts";

Deno.test("bounded request body rejects oversized declared and streamed payloads", async () => {
  const declared = await readRequestBodyLimited(
    new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "{}",
    }),
    16,
  );
  assertEquals(declared.tooLarge, true);
  assertEquals(declared.readError, false);

  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.enqueue(new Uint8Array(32));
      controller.close();
    },
  });
  const actual = await readRequestBodyLimited(
    new Request("https://example.test", { method: "POST", body: streamed }),
    16,
  );
  assertEquals(actual.tooLarge, true);
  assertEquals(actual.readError, false);
});

Deno.test("bounded request body reads a small empty JSON request", async () => {
  const result = await readRequestBodyLimited(
    new Request("https://example.test", { method: "POST", body: "{}" }),
    16,
  );
  assertEquals(result, {
    text: "{}",
    tooLarge: false,
    readError: false,
    timedOut: false,
  });
});

Deno.test("bounded request body rejects malformed UTF-8 instead of replacement-decoding", async () => {
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x7b, 0xff, 0x7d]));
      controller.close();
    },
  });
  const result = await readRequestBodyLimited(
    new Request("https://example.test", { method: "POST", body: streamed }),
    16,
  );
  assertEquals(result, {
    text: "",
    tooLarge: false,
    readError: true,
    timedOut: false,
  });
});

Deno.test("bounded request body times out and cancels a stalled stream", async () => {
  let cancelCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const result = await readRequestBodyLimited(
    new Request("https://example.test", { method: "POST", body: stream }),
    16,
    { timeoutMs: 20 },
  );
  await Promise.resolve();
  assertEquals(result, {
    text: "",
    tooLarge: false,
    readError: false,
    timedOut: true,
  });
  assertEquals(cancelCount, 1);
});

Deno.test("bounded request body propagates AbortSignal and cancels the stream", async () => {
  let cancelCount = 0;
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const pending = readRequestBodyLimited(
    new Request("https://example.test", { method: "POST", body: stream }),
    16,
    { signal: abort.signal, timeoutMs: 1_000 },
  );
  abort.abort(new DOMException("client disconnected", "AbortError"));
  assertEquals(await pending, {
    text: "",
    tooLarge: false,
    readError: true,
    timedOut: false,
  });
  await Promise.resolve();
  assertEquals(cancelCount, 1);
});

Deno.test("bounded request body leaves malformed JSON to the endpoint's 400 path", async () => {
  const result = await readRequestBodyLimited(
    new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":',
    }),
    16 * 1024,
  );
  assertEquals(result.tooLarge, false);
  assertEquals(result.readError, false);
  assertThrows(() => JSON.parse(result.text), SyntaxError);
});

Deno.test("bounded request byte reader preserves chunk order and exact bytes", async () => {
  const chunks = [
    new Uint8Array([0xef, 0xbb]),
    new Uint8Array([0xbf, 0xff, 0x00]),
  ];
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const result = await readRequestBytesLimited(
    new Request("https://example.test", { method: "POST", body: streamed }),
    16,
  );
  assertEquals(Array.from(result.bytes), [0xef, 0xbb, 0xbf, 0xff, 0x00]);
  assertEquals(result.tooLarge, false);
  assertEquals(result.readError, false);
});

Deno.test("bounded response body rejects declared and streamed oversized chunks", async () => {
  const declared = await readResponseBodyLimited(
    new Response("{}", { headers: { "content-length": "100" } }),
    16,
  );
  assertEquals(declared.tooLarge, true);
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.enqueue(new Uint8Array(32));
      controller.close();
    },
  });
  const actual = await readResponseBodyLimited(
    new Response(streamed),
    16,
  );
  assertEquals(actual.tooLarge, true);
  assertEquals(actual.readError, false);
});

Deno.test("bounded response body rejects malformed UTF-8", async () => {
  const result = await readResponseBodyLimited(
    new Response(new Uint8Array([0x7b, 0xff, 0x7d])),
    16,
  );
  assertEquals(result.text, "");
  assertEquals(result.tooLarge, false);
  assertEquals(result.readError, true);
});
