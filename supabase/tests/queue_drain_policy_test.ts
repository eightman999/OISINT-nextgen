import { assertEquals } from "@std/assert";
import {
  isQueueDrainTerminalContract,
  isTerminalizedCompleteResponse,
  queueDrainResponseStatus,
} from "../functions/_shared/queue_drain.ts";

Deno.test("queue drain: no rows and all rows are successful handoffs", () => {
  assertEquals(queueDrainResponseStatus(0, 0), 202);
  assertEquals(queueDrainResponseStatus(10, 10), 202);
});

Deno.test("queue drain: partial or malformed handoff is non-2xx", () => {
  assertEquals(queueDrainResponseStatus(10, 1), 503);
  assertEquals(queueDrainResponseStatus(10, 0), 503);
  assertEquals(queueDrainResponseStatus(-1, 0), 503);
  assertEquals(queueDrainResponseStatus(1, 2), 503);
});

Deno.test("queue drain: 409 is success only after complete-row reconciliation", () => {
  assertEquals(
    isQueueDrainTerminalContract({
      status: "complete",
      queue_terminalized: true,
    }),
    true,
  );
  assertEquals(isQueueDrainTerminalContract({ status: "complete" }), false);
  assertEquals(
    isQueueDrainTerminalContract({
      status: "complete",
      queue_terminalized: false,
    }),
    false,
  );
  assertEquals(
    isQueueDrainTerminalContract({
      status: "running",
      queue_terminalized: true,
    }),
    false,
  );
  assertEquals(isQueueDrainTerminalContract("complete"), false);
});

Deno.test("queue drain: terminal 409 response is a strict bounded UTF-8 contract", async () => {
  const valid = new Response(
    JSON.stringify({ status: "complete", queue_terminalized: true }),
    { status: 409 },
  );
  assertEquals(await isTerminalizedCompleteResponse(valid), true);

  const unknownShape = new Response(
    JSON.stringify({ status: "complete", queue_terminalized: true, extra: 1 }),
    { status: 409 },
  );
  assertEquals(await isTerminalizedCompleteResponse(unknownShape), false);

  const malformed = new Response('{"status":', { status: 409 });
  assertEquals(await isTerminalizedCompleteResponse(malformed), false);

  const invalidUtf8 = new Response(
    new Uint8Array([0x7b, 0xff, 0x7d]),
    { status: 409 },
  );
  assertEquals(await isTerminalizedCompleteResponse(invalidUtf8), false);

  const oversized = new Response(
    new Uint8Array(2049),
    { status: 409, headers: { "content-length": "2049" } },
  );
  assertEquals(await isTerminalizedCompleteResponse(oversized), false);
});

Deno.test("queue drain: stalled terminal bodyはdeadlineでcancelして拒否する", async () => {
  let cancelCount = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
      },
      cancel() {
        cancelCount += 1;
      },
    }),
    { status: 409 },
  );

  assertEquals(
    await isTerminalizedCompleteResponse(response, undefined, {
      timeoutMs: 20,
    }),
    false,
  );
  await Promise.resolve();
  assertEquals(cancelCount, 1);
});
