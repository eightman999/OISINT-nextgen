import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const endpoints = [
  {
    name: "create-investigation",
    path: "../functions/create-investigation/index.ts",
    limit: "MAX_CREATE_BODY_BYTES",
  },
  {
    name: "rerank-investigation",
    path: "../functions/rerank-investigation/index.ts",
    limit: "MAX_RERANK_BODY_BYTES",
  },
  {
    name: "join-investigation",
    path: "../functions/join-investigation/index.ts",
    limit: "MAX_JOIN_BODY_BYTES",
  },
  {
    name: "resolve-location",
    path: "../functions/resolve-location/index.ts",
    limit: "MAX_RESOLVE_LOCATION_BODY_BYTES",
  },
] as const;

for (const endpoint of endpoints) {
  const source = await Deno.readTextFile(
    new URL(endpoint.path, import.meta.url),
  );

  Deno.test(`${endpoint.name} は16 KiB bounded readerをJSON parse前に適用する`, () => {
    assertStringIncludes(source, "readRequestBodyLimited");
    assertStringIncludes(
      source,
      `const ${endpoint.limit} = 16 * 1024;`,
    );
    assertFalse(source.includes("req.json"));

    const reader = source.indexOf("readRequestBodyLimited");
    const bodyRead = source.indexOf("const boundedBody", reader);
    const timedOutGuard = source.indexOf(
      "if (boundedBody.timedOut)",
      bodyRead,
    );
    const oversizedGuard = source.indexOf(
      "if (boundedBody.tooLarge)",
      bodyRead,
    );
    const readErrorGuard = source.indexOf(
      "if (boundedBody.readError)",
      bodyRead,
    );
    const malformedGuard = source.indexOf("if (malformedJson)", bodyRead);
    const jsonParse = source.indexOf("JSON.parse(", bodyRead);
    const schemaValidation = source.indexOf(".safeParse(", bodyRead);
    assert(reader >= 0);
    assert(bodyRead > reader);
    assert(timedOutGuard > bodyRead);
    assert(oversizedGuard > timedOutGuard);
    assert(readErrorGuard > oversizedGuard);
    assert(jsonParse > readErrorGuard);
    assert(malformedGuard > readErrorGuard);
    assert(schemaValidation > malformedGuard);
    assertStringIncludes(
      source.slice(timedOutGuard, oversizedGuard),
      "408",
    );
    assertStringIncludes(
      source.slice(oversizedGuard, schemaValidation),
      "413",
    );
    assertStringIncludes(
      source.slice(readErrorGuard, jsonParse),
      "400",
    );
    assertStringIncludes(
      source.slice(malformedGuard, schemaValidation),
      "400",
    );
  });
}

const timeoutConsumers = [
  {
    path: "../functions/create-investigation/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/run-investigation/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/rerank-investigation/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/join-investigation/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/resolve-location/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/delete-investigation/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/delete-account/index.ts",
    reader: "readRequestBodyLimited",
  },
  {
    path: "../functions/revenuecat-webhook/index.ts",
    reader: "readRequestBytesLimited",
  },
] as const;

Deno.test("全request body consumerがdeadline signalと固定408を適用する", async () => {
  for (const endpoint of timeoutConsumers) {
    const source = await Deno.readTextFile(
      new URL(endpoint.path, import.meta.url),
    );
    const imported = source.indexOf(endpoint.reader);
    const call = source.indexOf(
      endpoint.reader,
      imported + endpoint.reader.length,
    );
    assert(call >= 0, endpoint.path);
    assertStringIncludes(source.slice(call), "signal:");
    assertStringIncludes(source.slice(call), ".timedOut");
    assertStringIncludes(source.slice(call), "408");
  }
});
