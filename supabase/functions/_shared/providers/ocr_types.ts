// メニュー画像 OCR の研究用契約 (#120 / spec.md §3 P2)
//
// OCR は Evidence writer や既存 AIProvider へ直接接続しない。ここで返す値は
// raw extraction と provenance 付きの「検証前 claim 候補」であり、source_url を
// 持つ Evidence ではない。利用側は必ずこのファイルの入力・出力境界を通すこと。
import { z } from "zod";
import type { StructuredClaim } from "../types.ts";
import {
  boundedStructuredClaimSchema,
  filterValidClaims,
  type StructuredClaimInput,
} from "../validation.ts";

// 画像は高解像度のメニュー写真を想定しつつ、研究段階でのメモリ/DoS を
// bounded にする。実運用のアップロード契約が決まったら、この定数と契約を
// 同時に見直す。呼び出し側の値で上限を拡大してはならない。
export const OCR_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const OCR_MAX_RAW_TEXT_CHARS = 2_000;
export const OCR_MAX_CLAIMS = 10;
export const OCR_MAX_FILE_ID_CHARS = 128;
export const OCR_MAX_PAGE = 10_000;
export const OCR_CLAIM_CONFIDENCE_THRESHOLD = 0.7;

export const OCR_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type OcrMimeType = (typeof OCR_ALLOWED_MIME_TYPES)[number];
export type OcrSourceKind = "user_upload" | "fixture";

/** 認証/同意境界の後に生成される入力。検索/SNS由来の画像は型上も受けない。 */
export interface OcrInput {
  image: {
    // bytes が無い参照だけの入力は、サイズと実体を検査できないため拒否する。
    // optional は将来 Storage 参照を受ける契約との互換性のために残している。
    bytes?: Uint8Array;
    mimeType: string;
    fileId?: string;
  };
  meta: {
    sourceKind: OcrSourceKind;
    page?: number;
  };
}

interface ValidatedOcrInput {
  image: {
    bytes: Uint8Array;
    mimeType: OcrMimeType;
    fileId?: string;
  };
  meta: {
    sourceKind: OcrSourceKind;
    page?: number;
  };
}

export type OcrInputRejectionReason =
  | "invalid_shape"
  | "permission_required"
  | "bytes_required"
  | "image_too_large"
  | "mime_not_allowed"
  | "image_signature_mismatch"
  | "file_id_invalid"
  | "page_invalid";

export type OcrInputValidation =
  | { ok: true; input: ValidatedOcrInput }
  | { ok: false; reason: OcrInputRejectionReason };

const FILE_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,${OCR_MAX_FILE_ID_CHARS - 1}}$`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function startsWithBytes(
  bytes: Uint8Array,
  prefix: readonly number[],
): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function hasImageSignature(
  mimeType: OcrMimeType,
  bytes: Uint8Array,
): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWithBytes(bytes, [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
    case "image/jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWithBytes(bytes, [
        0x52,
        0x49,
        0x46,
        0x46,
      ]) && startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  }
}

/**
 * OCR に渡せる入力を runtime で再検証する。
 * sourceKind は認証そのものではなく、認証/同意済み境界が生成する宣言値である。
 * この研究モジュールには upload endpoint が無いため、外部 caller が未認証値を
 * sourceKind に詰め替えないことを本番統合時の前提とする。
 */
export function validateOcrInput(input: unknown): OcrInputValidation {
  if (!isRecord(input) || !isRecord(input.image) || !isRecord(input.meta)) {
    return { ok: false, reason: "invalid_shape" };
  }

  const sourceKind = input.meta.sourceKind;
  if (sourceKind !== "user_upload" && sourceKind !== "fixture") {
    return { ok: false, reason: "permission_required" };
  }

  const bytes = input.image.bytes;
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, reason: "bytes_required" };
  }
  if (bytes.byteLength > OCR_MAX_IMAGE_BYTES) {
    return { ok: false, reason: "image_too_large" };
  }

  const mimeType = input.image.mimeType;
  if (
    typeof mimeType !== "string" ||
    !(OCR_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)
  ) {
    return { ok: false, reason: "mime_not_allowed" };
  }
  if (!hasImageSignature(mimeType as OcrMimeType, bytes)) {
    return { ok: false, reason: "image_signature_mismatch" };
  }

  const fileId = input.image.fileId;
  if (
    fileId !== undefined &&
    (typeof fileId !== "string" || !FILE_ID_PATTERN.test(fileId))
  ) {
    return { ok: false, reason: "file_id_invalid" };
  }

  const page = input.meta.page;
  if (
    page !== undefined &&
    (typeof page !== "number" ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > OCR_MAX_PAGE)
  ) {
    return { ok: false, reason: "page_invalid" };
  }

  return {
    ok: true,
    input: {
      image: {
        bytes,
        mimeType: mimeType as OcrMimeType,
        ...(fileId === undefined ? {} : { fileId }),
      },
      meta: {
        sourceKind,
        ...(page === undefined ? {} : { page }),
      },
    },
  };
}

const normalizedBboxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]).refine(
  (bbox) => bbox.every((value) => value >= 0 && value <= 1),
  "bbox must use normalized coordinates in the 0..1 range",
);

const provenanceSchema = z.object({
  fileId: z.string().min(1).max(OCR_MAX_FILE_ID_CHARS).regex(FILE_ID_PATTERN)
    .optional(),
  page: z.number().int().min(1).max(OCR_MAX_PAGE).optional(),
  // null is intentional: bbox extraction is provider-dependent and optional.
  bbox: normalizedBboxSchema.nullable().optional(),
}).strict();

/** OCR claim の schema。confidence の範囲は schema で弾かず、claim 単位で破棄する。 */
export const ocrClaimSchema = boundedStructuredClaimSchema.extend({
  confidence: z.number().finite(),
  provenance: provenanceSchema,
}).strict();

export const ocrExtractionSchema = z.object({
  claims: z.array(ocrClaimSchema).max(OCR_MAX_CLAIMS),
  // rawText はデバッグ/再評価用であり、Evidence の excerpt ではない。
  rawText: z.string().max(OCR_MAX_RAW_TEXT_CHARS),
}).strict();

export type OcrClaim = StructuredClaim & {
  confidence: number;
  provenance: {
    fileId?: string;
    page?: number;
    bbox?: [number, number, number, number] | null;
  };
};

export interface OcrExtraction {
  claims: OcrClaim[];
  rawText: string;
}

export type OcrExtractionParseResult =
  | { ok: true; data: OcrExtraction; droppedClaims: number }
  | { ok: false; reason: "input_invalid" | "schema_invalid" };

function provenanceMatchesInput(
  claim: OcrClaim,
  input: ValidatedOcrInput,
): boolean {
  // 出力が参照を付ける場合は、呼び出し入力の参照と完全一致させる。
  // 一致しない file/page を部分的に補正して採用することは禁止する。
  if (claim.provenance.fileId !== input.image.fileId) return false;
  if (
    claim.provenance.page !== undefined &&
    input.meta.page !== undefined &&
    claim.provenance.page !== input.meta.page
  ) {
    return false;
  }
  if (claim.provenance.page !== undefined && input.meta.page === undefined) {
    return false;
  }
  return true;
}

function parseValidatedOcrExtraction(
  raw: unknown,
  input: ValidatedOcrInput,
): OcrExtractionParseResult {
  // 外部/モデル値は必ず safeParse してから semantic filter へ進める。
  const parsed = ocrExtractionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema_invalid" };

  const accepted: OcrClaim[] = [];
  for (const claim of parsed.data.claims) {
    // 0..1 外は clamp せず、その claim だけを unknown 相当として捨てる。
    if (
      claim.confidence < OCR_CLAIM_CONFIDENCE_THRESHOLD ||
      claim.confidence > 1
    ) continue;
    if (!provenanceMatchesInput(claim, input)) continue;
    const validClaim = filterValidClaims([claim as StructuredClaimInput]);
    if (validClaim.length !== 1) continue;
    accepted.push(claim as OcrClaim);
  }

  return {
    ok: true,
    data: { rawText: parsed.data.rawText, claims: accepted },
    droppedClaims: parsed.data.claims.length - accepted.length,
  };
}

/**
 * 入力検証と出力 safeParse を一つの fail-closed 境界にまとめる。
 * 失敗した structured output に含まれる値や Zod message は外へ返さない。
 */
export function parseOcrExtraction(
  raw: unknown,
  input: OcrInput,
): OcrExtractionParseResult {
  const checked = validateOcrInput(input);
  if (!checked.ok) return { ok: false, reason: "input_invalid" };
  return parseValidatedOcrExtraction(raw, checked.input);
}

export interface OcrAttemptContext {
  attempt: 1 | 2;
  previousFailure: "schema_invalid" | null;
}

export type OcrRunResult =
  | {
    status: "ok";
    extraction: OcrExtraction;
    attempts: 1 | 2;
    droppedClaims: number;
  }
  | { status: "rejected"; reason: "input_invalid"; attempts: 0 }
  | {
    status: "failed";
    reason: "schema_invalid" | "provider_error" | "unknown_fixture";
    attempts: 0 | 1 | 2;
  };

export interface OcrProvider {
  extract(input: OcrInput, signal?: AbortSignal): Promise<OcrRunResult>;
}

/** Structured output の検証失敗だけを一度だけ再要求する mock/live 共通境界。 */
export async function runOcrStructuredWithRetry(
  input: OcrInput,
  call: (context: OcrAttemptContext) => Promise<unknown>,
): Promise<OcrRunResult> {
  const checked = validateOcrInput(input);
  if (!checked.ok) {
    return { status: "rejected", reason: "input_invalid", attempts: 0 };
  }

  let previousFailure: "schema_invalid" | null = null;
  for (const attempt of [1, 2] as const) {
    let raw: unknown;
    try {
      raw = await call({ attempt, previousFailure });
    } catch {
      // provider の詳細/入力値を結果へ漏らさず、外側では一律 fail closed。
      return { status: "failed", reason: "provider_error", attempts: attempt };
    }
    const parsed = parseValidatedOcrExtraction(raw, checked.input);
    if (parsed.ok) {
      return {
        status: "ok",
        extraction: parsed.data,
        attempts: attempt,
        droppedClaims: parsed.droppedClaims,
      };
    }
    previousFailure = "schema_invalid";
  }
  return { status: "failed", reason: "schema_invalid", attempts: 2 };
}
