// Backend-neutral archive boundary (#516).
//
// このモジュールは object storage の vendor SDK / URI を知らない。呼び出し側が
// opaque な storageBackend と objectKey を渡し、blob adapter は同じ契約だけを実装する。
// archive metadata は不変で、rehydrate 時にサイズと SHA-256 を再検証する。

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_MAX_LENGTH = 512;
const STORAGE_BACKEND_MAX_LENGTH = 128;
const OBJECT_KEY_MAX_LENGTH = 2048;
const SCHEMA_VERSION_MAX_LENGTH = 80;
const SOURCE_REF_MAX_LENGTH = 512;
const ARTIFACT_KIND_MAX_LENGTH = 128;
const ARTIFACT_VERSION_MAX_LENGTH = 80;
const EMBEDDING_MODEL_MAX_LENGTH = 160;
const EMBEDDING_VERSION_MAX_LENGTH = 80;

export type ArchiveStoreErrorCode =
  | "invalid_input"
  | "not_found"
  | "missing_payload"
  | "integrity_failure"
  | "backend_failure";

/** 呼び出し側が障害を「不明データ」と取り違えないための閉じたエラー型。 */
export class ArchiveStoreError extends Error {
  readonly code: ArchiveStoreErrorCode;

  constructor(code: ArchiveStoreErrorCode, message: string) {
    super(message);
    this.name = "ArchiveStoreError";
    this.code = code;
  }
}

/**
 * adapter は実際の保存先を一つに固定しない。
 * storageBackend は識別子としてだけ渡し、URIの組み立ては行わない。
 */
export interface ArchiveBlobStore {
  put(
    storageBackend: string,
    objectKey: string,
    content: Uint8Array,
  ): Promise<void>;
  get(
    storageBackend: string,
    objectKey: string,
  ): Promise<Uint8Array | null>;
  delete(storageBackend: string, objectKey: string): Promise<void>;
}

export interface ArchivePutInput {
  /** 未指定時は adapter 境界で UUID を生成する。 */
  id?: string;
  /** 外部保存先の object key。vendor URI ではなく opaque 値。 */
  objectKey: string;
  storageBackend: string;
  schemaVersion: string;
  content: Uint8Array;
  /** 指定時は計算値と一致する場合だけ受理する。 */
  contentHash?: string;
  /** 削除対象を追跡できる場合だけ指定する opaque provenance。 */
  sourceRef?: string;
  archivedAt?: string;
}

export interface ArchiveObject {
  readonly id: string;
  readonly contentHash: string;
  readonly storageBackend: string;
  readonly objectKey: string;
  readonly schemaVersion: string;
  readonly sizeBytes: number;
  readonly archivedAt: string;
  readonly sourceRef?: string;
}

export interface DerivedPutInput {
  id?: string;
  sourceRef: string;
  artifactKind: string;
  sourceVersion: string;
  artifactVersion: string;
  contentHash?: string;
  embeddingModel?: string;
  embeddingVersion?: string;
  createdAt?: string;
}

export interface DerivedArtifact {
  readonly id: string;
  readonly sourceRef: string;
  readonly artifactKind: string;
  readonly sourceVersion: string;
  readonly artifactVersion: string;
  readonly contentHash?: string;
  readonly embeddingModel?: string;
  readonly embeddingVersion?: string;
  readonly createdAt: string;
}

export interface ArchivePurgeResult {
  readonly archiveDeleted: number;
  readonly derivedDeleted: number;
}

/**
 * archive 本体と再生成可能な derived metadata を同じ lifecycle 境界へ置く。
 * 実DB adapter はこの interface を実装し、呼び出し側は保存先を意識しない。
 */
export interface ArchiveStore {
  put(input: ArchivePutInput): Promise<ArchiveObject>;
  get(id: string): Promise<ArchiveObject | null>;
  rehydrate(id: string): Promise<Uint8Array>;
  putDerived(input: DerivedPutInput): Promise<DerivedArtifact>;
  getDerived(id: string): Promise<DerivedArtifact | null>;
  purgeArchive(id: string): Promise<boolean>;
  /** sourceRef に紐づく derived artifact を全件 purge する。 */
  purgeDerived(sourceRef: string): Promise<number>;
  purgeDerivedById(id: string): Promise<boolean>;
  purgeBySource(sourceRef: string): Promise<ArchivePurgeResult>;
}

function failInvalid(message: string): never {
  throw new ArchiveStoreError("invalid_input", message);
}

function opaqueText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > maxLength || value !== value.trim() ||
    value.includes("\u0000") || value.includes("\u0001")
  ) {
    return failInvalid(`${field} is invalid`);
  }
  return value;
}

function optionalOpaqueText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return opaqueText(value, field, maxLength);
}

function validTimestamp(value: unknown, field: string): string {
  const text = opaqueText(value, field, 80);
  if (!Number.isFinite(Date.parse(text))) {
    return failInvalid(`${field} is invalid`);
  }
  return text;
}

function validateContentHash(value: unknown, field = "contentHash"): string {
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    return failInvalid(`${field} is invalid`);
  }
  return value;
}

function validateBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) return failInvalid("content is invalid");
  return new Uint8Array(value);
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneArchiveObject(value: ArchiveObject): ArchiveObject {
  return { ...value };
}

function cloneDerivedArtifact(value: DerivedArtifact): DerivedArtifact {
  return { ...value };
}

function compoundKey(...parts: string[]): string {
  // 各値はNULとseparatorを拒否済み。separatorは外部へ公開しない内部map専用。
  return parts.join("\u0001");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Web Cryptoだけを使う、保存先非依存の content hash。 */
export async function sha256Hex(content: Uint8Array): Promise<string> {
  const bytes = validateBytes(content);
  // validateBytes()でoffsetのないコピーを作っているため、Web Cryptoの
  // ArrayBuffer契約へ明示的に合わせる（DenoのArrayBufferLike型差異を吸収）。
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Deno test / local fixture 用の in-memory blob adapter。
 * 同じ object key を別 bytes で上書きしないため、immutable snapshot の誤更新を検出する。
 */
export class MemoryArchiveBlobStore implements ArchiveBlobStore {
  private readonly objects = new Map<string, Uint8Array>();

  private key(storageBackend: string, objectKey: string): string {
    return compoundKey(storageBackend, objectKey);
  }

  put(
    storageBackend: string,
    objectKey: string,
    content: Uint8Array,
  ): Promise<void> {
    const key = this.key(storageBackend, objectKey);
    const bytes = validateBytes(content);
    const existing = this.objects.get(key);
    if (existing !== undefined) {
      if (!sameBytes(existing, bytes)) {
        throw new Error("immutable archive object key collision");
      }
      return Promise.resolve();
    }
    this.objects.set(key, cloneBytes(bytes));
    return Promise.resolve();
  }

  get(
    storageBackend: string,
    objectKey: string,
  ): Promise<Uint8Array | null> {
    const value = this.objects.get(this.key(storageBackend, objectKey));
    return Promise.resolve(value === undefined ? null : cloneBytes(value));
  }

  delete(storageBackend: string, objectKey: string): Promise<void> {
    this.objects.delete(this.key(storageBackend, objectKey));
    return Promise.resolve();
  }

  /** テストで保存先の欠損を再現する。業務ロジックからは呼ばない。 */
  remove(storageBackend: string, objectKey: string): void {
    this.objects.delete(this.key(storageBackend, objectKey));
  }

  /** テストで保存先の改竄を再現する。業務ロジックからは呼ばない。 */
  tamper(storageBackend: string, objectKey: string, content: Uint8Array): void {
    this.objects.set(
      this.key(storageBackend, objectKey),
      validateBytes(content),
    );
  }
}

async function backendCall<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    // adapter の例外本文（URI・資格情報・vendor固有情報を含み得る）は境界外へ出さない。
    throw new ArchiveStoreError(
      "backend_failure",
      `archive backend ${operation} failed`,
    );
  }
}

/** 実DB/実object storageを使わずに lifecycle を検証する mock adapter。 */
export class MemoryArchiveStore implements ArchiveStore {
  private readonly archives = new Map<string, ArchiveObject>();
  private readonly archiveDedupe = new Map<string, string>();
  private readonly archiveObjectKeys = new Map<string, string>();
  private readonly derived = new Map<string, DerivedArtifact>();
  private readonly derivedDedupe = new Map<string, string>();

  constructor(
    private readonly blobs: ArchiveBlobStore = new MemoryArchiveBlobStore(),
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  async put(input: ArchivePutInput): Promise<ArchiveObject> {
    const objectKey = opaqueText(
      input.objectKey,
      "objectKey",
      OBJECT_KEY_MAX_LENGTH,
    );
    const storageBackend = opaqueText(
      input.storageBackend,
      "storageBackend",
      STORAGE_BACKEND_MAX_LENGTH,
    );
    const schemaVersion = opaqueText(
      input.schemaVersion,
      "schemaVersion",
      SCHEMA_VERSION_MAX_LENGTH,
    );
    const content = validateBytes(input.content);
    let actualHash: string;
    try {
      actualHash = await sha256Hex(content);
    } catch {
      throw new ArchiveStoreError("integrity_failure", "content hash failed");
    }
    const contentHash = input.contentHash === undefined
      ? actualHash
      : validateContentHash(input.contentHash);
    if (contentHash !== actualHash) {
      return failInvalid("contentHash does not match content");
    }

    const requestedId = input.id === undefined
      ? undefined
      : opaqueText(input.id, "id", OPAQUE_ID_MAX_LENGTH);
    const sourceRef = optionalOpaqueText(
      input.sourceRef,
      "sourceRef",
      SOURCE_REF_MAX_LENGTH,
    );
    const archivedAt = input.archivedAt === undefined
      ? new Date().toISOString()
      : validTimestamp(input.archivedAt, "archivedAt");

    const dedupeKey = compoundKey(storageBackend, contentHash, schemaVersion);
    const existingId = this.archiveDedupe.get(dedupeKey);
    if (existingId !== undefined) {
      const existing = this.archives.get(existingId);
      if (existing === undefined) {
        // 内部indexの不整合を成功扱いにしない。
        throw new ArchiveStoreError(
          "integrity_failure",
          "archive index is inconsistent",
        );
      }
      // 同じblobを異なる削除境界へ黙って共有すると、一方のsource purgeで
      // 他方の参照を失う。参照テーブルを導入するまでは競合をfail-closedにする。
      if (existing.sourceRef !== sourceRef) {
        throw new ArchiveStoreError(
          "integrity_failure",
          "archive dedupe provenance conflicts",
        );
      }
      return cloneArchiveObject(existing);
    }

    const id = requestedId === undefined
      ? opaqueText(this.idFactory(), "id", OPAQUE_ID_MAX_LENGTH)
      : requestedId;
    if (this.archives.has(id)) {
      return failInvalid("archive id already exists");
    }
    const objectIdentity = compoundKey(storageBackend, objectKey);
    if (this.archiveObjectKeys.has(objectIdentity)) {
      throw new ArchiveStoreError(
        "integrity_failure",
        "archive object key is already bound",
      );
    }

    // metadata はbackend書き込み成功後だけ登録する。途中失敗を「保存済み」と扱わない。
    await backendCall(
      "put",
      () => this.blobs.put(storageBackend, objectKey, cloneBytes(content)),
    );

    const record: ArchiveObject = {
      id,
      contentHash,
      storageBackend,
      objectKey,
      schemaVersion,
      sizeBytes: content.byteLength,
      archivedAt,
      ...(sourceRef === undefined ? {} : { sourceRef }),
    };
    this.archives.set(id, record);
    this.archiveDedupe.set(dedupeKey, id);
    this.archiveObjectKeys.set(objectIdentity, id);
    return cloneArchiveObject(record);
  }

  get(id: string): Promise<ArchiveObject | null> {
    const archiveId = opaqueText(id, "id", OPAQUE_ID_MAX_LENGTH);
    const record = this.archives.get(archiveId);
    return Promise.resolve(
      record === undefined ? null : cloneArchiveObject(record),
    );
  }

  async rehydrate(id: string): Promise<Uint8Array> {
    const archiveId = opaqueText(id, "id", OPAQUE_ID_MAX_LENGTH);
    const record = this.archives.get(archiveId);
    if (record === undefined) {
      throw new ArchiveStoreError("not_found", "archive object not found");
    }

    const payload = await backendCall(
      "get",
      () => this.blobs.get(record.storageBackend, record.objectKey),
    );
    if (payload === null) {
      throw new ArchiveStoreError(
        "missing_payload",
        "archive payload is missing",
      );
    }
    if (!(payload instanceof Uint8Array)) {
      throw new ArchiveStoreError(
        "integrity_failure",
        "archive payload type is invalid",
      );
    }
    if (payload.byteLength !== record.sizeBytes) {
      throw new ArchiveStoreError(
        "integrity_failure",
        "archive payload size mismatch",
      );
    }
    let actualHash: string;
    try {
      actualHash = await sha256Hex(payload);
    } catch {
      throw new ArchiveStoreError(
        "integrity_failure",
        "archive payload hash failed",
      );
    }
    if (actualHash !== record.contentHash) {
      throw new ArchiveStoreError(
        "integrity_failure",
        "archive payload hash mismatch",
      );
    }
    return cloneBytes(payload);
  }

  putDerived(input: DerivedPutInput): Promise<DerivedArtifact> {
    const sourceRef = opaqueText(
      input.sourceRef,
      "sourceRef",
      SOURCE_REF_MAX_LENGTH,
    );
    const artifactKind = opaqueText(
      input.artifactKind,
      "artifactKind",
      ARTIFACT_KIND_MAX_LENGTH,
    );
    const sourceVersion = opaqueText(
      input.sourceVersion,
      "sourceVersion",
      SCHEMA_VERSION_MAX_LENGTH,
    );
    const artifactVersion = opaqueText(
      input.artifactVersion,
      "artifactVersion",
      ARTIFACT_VERSION_MAX_LENGTH,
    );
    const contentHash = input.contentHash === undefined
      ? undefined
      : validateContentHash(input.contentHash, "contentHash");
    const embeddingModel = optionalOpaqueText(
      input.embeddingModel,
      "embeddingModel",
      EMBEDDING_MODEL_MAX_LENGTH,
    );
    const embeddingVersion = optionalOpaqueText(
      input.embeddingVersion,
      "embeddingVersion",
      EMBEDDING_VERSION_MAX_LENGTH,
    );
    const requestedId = input.id === undefined
      ? undefined
      : opaqueText(input.id, "id", OPAQUE_ID_MAX_LENGTH);
    const createdAt = input.createdAt === undefined
      ? new Date().toISOString()
      : validTimestamp(input.createdAt, "createdAt");
    const dedupeKey = compoundKey(
      sourceRef,
      artifactKind,
      sourceVersion,
      artifactVersion,
    );
    const existingId = this.derivedDedupe.get(dedupeKey);
    if (existingId !== undefined) {
      const existing = this.derived.get(existingId);
      if (existing === undefined) {
        throw new ArchiveStoreError(
          "integrity_failure",
          "derived index is inconsistent",
        );
      }
      if (
        existing.contentHash !== contentHash ||
        existing.embeddingModel !== embeddingModel ||
        existing.embeddingVersion !== embeddingVersion
      ) {
        throw new ArchiveStoreError(
          "integrity_failure",
          "derived artifact metadata is immutable",
        );
      }
      return Promise.resolve(cloneDerivedArtifact(existing));
    }
    const id = requestedId === undefined
      ? opaqueText(this.idFactory(), "id", OPAQUE_ID_MAX_LENGTH)
      : requestedId;
    const artifact: DerivedArtifact = {
      id,
      sourceRef,
      artifactKind,
      sourceVersion,
      artifactVersion,
      createdAt,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(embeddingModel === undefined ? {} : { embeddingModel }),
      ...(embeddingVersion === undefined ? {} : { embeddingVersion }),
    };
    if (this.derived.has(id)) {
      return failInvalid("derived artifact id already exists");
    }
    this.derived.set(id, artifact);
    this.derivedDedupe.set(dedupeKey, id);
    return Promise.resolve(cloneDerivedArtifact(artifact));
  }

  getDerived(id: string): Promise<DerivedArtifact | null> {
    const artifactId = opaqueText(id, "id", OPAQUE_ID_MAX_LENGTH);
    const artifact = this.derived.get(artifactId);
    return Promise.resolve(
      artifact === undefined ? null : cloneDerivedArtifact(artifact),
    );
  }

  async purgeArchive(id: string): Promise<boolean> {
    const archiveId = opaqueText(id, "id", OPAQUE_ID_MAX_LENGTH);
    const record = this.archives.get(archiveId);
    if (record === undefined) return false;
    await backendCall(
      "delete",
      () => this.blobs.delete(record.storageBackend, record.objectKey),
    );
    this.archives.delete(archiveId);
    this.archiveObjectKeys.delete(
      compoundKey(record.storageBackend, record.objectKey),
    );
    this.archiveDedupe.delete(
      compoundKey(
        record.storageBackend,
        record.contentHash,
        record.schemaVersion,
      ),
    );
    return true;
  }

  purgeDerived(sourceRef: string): Promise<number> {
    const ref = opaqueText(sourceRef, "sourceRef", SOURCE_REF_MAX_LENGTH);
    let deleted = 0;
    for (const [id, artifact] of this.derived) {
      if (artifact.sourceRef === ref) {
        this.derived.delete(id);
        this.derivedDedupe.delete(
          compoundKey(
            artifact.sourceRef,
            artifact.artifactKind,
            artifact.sourceVersion,
            artifact.artifactVersion,
          ),
        );
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  purgeDerivedById(id: string): Promise<boolean> {
    const artifactId = opaqueText(id, "id", OPAQUE_ID_MAX_LENGTH);
    const artifact = this.derived.get(artifactId);
    if (artifact === undefined) return Promise.resolve(false);
    this.derived.delete(artifactId);
    this.derivedDedupe.delete(
      compoundKey(
        artifact.sourceRef,
        artifact.artifactKind,
        artifact.sourceVersion,
        artifact.artifactVersion,
      ),
    );
    return Promise.resolve(true);
  }

  async purgeBySource(sourceRef: string): Promise<ArchivePurgeResult> {
    const ref = opaqueText(sourceRef, "sourceRef", SOURCE_REF_MAX_LENGTH);
    const archiveIds = [...this.archives.values()]
      .filter((record) => record.sourceRef === ref)
      .map((record) => record.id);
    let archiveDeleted = 0;
    for (const id of archiveIds) {
      if (await this.purgeArchive(id)) archiveDeleted += 1;
    }
    const derivedDeleted = await this.purgeDerived(ref);
    return { archiveDeleted, derivedDeleted };
  }
}
