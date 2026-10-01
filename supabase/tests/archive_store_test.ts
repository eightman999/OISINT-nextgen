import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type ArchiveBlobStore,
  type ArchiveObject,
  ArchiveStoreError,
  MemoryArchiveBlobStore,
  MemoryArchiveStore,
  sha256Hex,
} from "../functions/_shared/archive_store.ts";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

async function expectArchiveError(
  operation: () => Promise<unknown>,
  code: ArchiveStoreError["code"],
): Promise<void> {
  const error = await assertRejects(operation, ArchiveStoreError);
  assertEquals(error.code, code);
}

function archiveInput(
  content: Uint8Array,
  overrides: Partial<ArchiveObject> = {},
) {
  return {
    id: overrides.id,
    objectKey: overrides.objectKey ?? "evidence/one.snapshot",
    storageBackend: overrides.storageBackend ?? "test-backend",
    schemaVersion: overrides.schemaVersion ?? "evidence-v1",
    content,
    sourceRef: overrides.sourceRef ?? "evidence:one",
    archivedAt: overrides.archivedAt ?? "2026-08-30T00:00:00.000Z",
  };
}

Deno.test("ArchiveStore は put/get/rehydrate と content-addressed dedupe を提供する", async () => {
  const blobs = new MemoryArchiveBlobStore();
  const store = new MemoryArchiveStore(blobs, () => "archive-one");
  const content = bytes("immutable evidence snapshot");
  const contentHash = await sha256Hex(content);

  const record = await store.put({
    ...archiveInput(content, { id: "archive-one" }),
    contentHash,
  });
  assertEquals(record.contentHash, contentHash);
  assertEquals(record.sizeBytes, content.byteLength);
  assertEquals(await store.get(record.id), record);
  assertEquals(await store.rehydrate(record.id), content);

  // 同一backend・hash・schemaは別object key/IDを増やさず既存snapshotへ収束する。
  const duplicate = await store.put({
    ...archiveInput(content, {
      id: "archive-two",
      objectKey: "evidence/two.snapshot",
    }),
    contentHash,
  });
  assertEquals(duplicate.id, record.id);
  assertEquals(await store.get("archive-two"), null);
});

Deno.test("ArchiveStore は計算したSHA-256と異なる入力hashを受理しない", async () => {
  const store = new MemoryArchiveStore();
  await expectArchiveError(
    () =>
      store.put({
        ...archiveInput(bytes("actual"), { id: "archive-invalid-hash" }),
        contentHash: "0".repeat(64),
      }),
    "invalid_input",
  );
  assertEquals(await store.get("archive-invalid-hash"), null);
});

Deno.test("ArchiveStore は同一hashを異なるsourceRefへ黙って共有しない", async () => {
  const store = new MemoryArchiveStore();
  const content = bytes("shared bytes");
  await store.put({
    ...archiveInput(content, {
      id: "archive-source-a",
      sourceRef: "account:a",
    }),
  });
  await expectArchiveError(
    () =>
      store.put({
        ...archiveInput(content, {
          id: "archive-source-b",
          objectKey: "evidence/source-b.snapshot",
          sourceRef: "account:b",
        }),
      }),
    "integrity_failure",
  );
  assertEquals(await store.get("archive-source-b"), null);
});

Deno.test("ArchiveStore は欠損payloadをnot_found/missing_payloadとして閉じる", async () => {
  const blobs = new MemoryArchiveBlobStore();
  const store = new MemoryArchiveStore(blobs);
  const record = await store.put({
    ...archiveInput(bytes("payload"), { id: "archive-missing" }),
  });

  blobs.remove(record.storageBackend, record.objectKey);
  await expectArchiveError(
    () => store.rehydrate(record.id),
    "missing_payload",
  );
  await expectArchiveError(
    () => store.rehydrate("archive-does-not-exist"),
    "not_found",
  );
});

Deno.test("ArchiveStore はrehydrate時の改竄をintegrity_failureへ収束する", async () => {
  const blobs = new MemoryArchiveBlobStore();
  const store = new MemoryArchiveStore(blobs);
  const record = await store.put({
    ...archiveInput(bytes("original"), { id: "archive-tampered" }),
  });

  blobs.tamper(record.storageBackend, record.objectKey, bytes("tampered"));
  await expectArchiveError(
    () => store.rehydrate(record.id),
    "integrity_failure",
  );
});

class FailingBlobStore implements ArchiveBlobStore {
  private readonly delegate = new MemoryArchiveBlobStore();
  operation: "put" | "get" | "delete" | null = null;

  async put(
    storageBackend: string,
    objectKey: string,
    content: Uint8Array,
  ): Promise<void> {
    if (this.operation === "put") throw new Error("backend unavailable");
    await this.delegate.put(storageBackend, objectKey, content);
  }

  async get(
    storageBackend: string,
    objectKey: string,
  ): Promise<Uint8Array | null> {
    if (this.operation === "get") throw new Error("backend unavailable");
    return await this.delegate.get(storageBackend, objectKey);
  }

  async delete(storageBackend: string, objectKey: string): Promise<void> {
    if (this.operation === "delete") throw new Error("backend unavailable");
    await this.delegate.delete(storageBackend, objectKey);
  }
}

Deno.test("ArchiveStore はbackend put/get/delete failureを成功やunknownへ変換しない", async () => {
  const blobs = new FailingBlobStore();
  const store = new MemoryArchiveStore(blobs);
  blobs.operation = "put";
  await expectArchiveError(
    () =>
      store.put(
        archiveInput(bytes("backend failure"), { id: "archive-failed-put" }),
      ),
    "backend_failure",
  );
  assertEquals(await store.get("archive-failed-put"), null);

  blobs.operation = null;
  const record = await store.put({
    ...archiveInput(bytes("backend failure after put"), {
      id: "archive-failed-get",
    }),
  });
  blobs.operation = "get";
  await expectArchiveError(
    () => store.rehydrate(record.id),
    "backend_failure",
  );
  blobs.operation = "delete";
  await expectArchiveError(
    () => store.purgeArchive(record.id),
    "backend_failure",
  );
  assert((await store.get(record.id)) !== null);
});

Deno.test("ArchiveStore はarchiveとderivedをsourceRef単位でpurgeする", async () => {
  const store = new MemoryArchiveStore();
  const first = await store.put({
    ...archiveInput(bytes("first"), {
      id: "archive-source-one",
      sourceRef: "account:one",
    }),
  });
  const second = await store.put({
    ...archiveInput(bytes("second"), {
      id: "archive-source-two",
      objectKey: "evidence/source-two.snapshot",
      sourceRef: "account:two",
    }),
  });
  const derivedOne = await store.putDerived({
    id: "derived-source-one",
    sourceRef: "account:one",
    artifactKind: "place_vector",
    sourceVersion: "facts-v1",
    artifactVersion: "embedding-v1",
    embeddingModel: "model-opaque",
    embeddingVersion: "embedding-v1",
  });
  await store.putDerived({
    id: "derived-source-two",
    sourceRef: "account:two",
    artifactKind: "place_vector",
    sourceVersion: "facts-v1",
    artifactVersion: "embedding-v1",
  });

  assertEquals(await store.purgeDerivedById(derivedOne.id), true);
  assertEquals(await store.getDerived(derivedOne.id), null);
  const result = await store.purgeBySource("account:two");
  assertEquals(result, { archiveDeleted: 1, derivedDeleted: 1 });
  assertEquals(await store.get(second.id), null);
  assertEquals(await store.get(first.id) !== null, true);
  assertEquals(await store.purgeDerived("account:one"), 0);
});

Deno.test("#516 archive migration はopaque backend・hash制約・RLS・service purgeを定義する", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../migrations/202608300010_archive_lifecycle.sql",
      import.meta.url,
    ),
  );
  for (
    const fragment of [
      "create table public.archive_objects",
      "content_hash text not null",
      "storage_backend text not null",
      "object_key text not null",
      "purge_requested_at timestamptz",
      "unique (storage_backend, content_hash, schema_version)",
      "create table public.derived_artifacts",
      "alter table public.archive_objects enable row level security",
      "alter table public.derived_artifacts enable row level security",
      "grant all on public.archive_objects, public.derived_artifacts to service_role",
      "create or replace function public.request_archive_lifecycle_purge",
      "create or replace function public.finalize_archive_purge",
    ]
  ) {
    assertStringIncludes(migration, fragment);
  }
  assert(!migration.includes("r2"));
  assert(!migration.includes("s3"));
});
