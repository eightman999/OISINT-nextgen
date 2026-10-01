// メニュー画像 OCR の mock provider (#120)
// 外部 API、Storage、ネットワークには一切接続しない。実 provider を追加する場合も
// OcrProvider と runOcrStructuredWithRetry を共有し、出力境界を迂回しないこと。
import {
  type OcrInput,
  type OcrProvider,
  type OcrRunResult,
  runOcrStructuredWithRetry,
  validateOcrInput,
} from "./ocr_types.ts";

type MockOcrResponse = {
  rawText: string;
  claims: Array<{
    key:
      | "opening_hours"
      | "closed_days"
      | "budget_dinner"
      | "card_accepted"
      | "reservation"
      | "private_room"
      | "capacity"
      | "genre"
      | "noise_level"
      | "time_limit";
    value: unknown;
    rawText: string;
    confidence: number;
    provenance: {
      fileId?: string;
      page?: number;
      bbox?: [number, number, number, number] | null;
    };
  }>;
};

function claim(
  fileId: string,
  value: unknown,
  rawText: string,
  confidence: number,
): MockOcrResponse["claims"][number] {
  return {
    key: "budget_dinner",
    value,
    rawText,
    confidence,
    provenance: { fileId, page: 1, bbox: null },
  };
}

function budget(min: number, max: number): { min: number; max: number } {
  return { min, max };
}

/**
 * 小さな合成 fixture の期待出力。実画像を外部から収集せず、OCR provider の
 * 契約・評価 harness を先に検証するためのもの。低品質画像は候補を返すが、
 * 共通境界の confidence 閾値で claim 0 件になる。
 */
export const MOCK_OCR_FIXTURES: Readonly<Record<string, MockOcrResponse>> = {
  "menu-3000": {
    rawText: "夕食 3000円",
    claims: [claim("menu-3000", budget(3000, 3000), "夕食 3000円", 0.96)],
  },
  "menu-3000-comma": {
    rawText: "夕食 3,000円",
    claims: [
      claim("menu-3000-comma", budget(3000, 3000), "夕食 3,000円", 0.95),
    ],
  },
  "menu-tax-included": {
    rawText: "税込 3,300円",
    claims: [
      claim("menu-tax-included", budget(3300, 3300), "税込 3,300円", 0.93),
    ],
  },
  "menu-lunch-dinner": {
    rawText: "ランチ 1,200円 / ディナー 3,500円",
    // ClaimKey に budget_lunch は存在しないため、夕食値だけを構造化する。
    claims: [
      claim("menu-lunch-dinner", budget(3500, 3500), "ディナー 3,500円", 0.9),
    ],
  },
  "menu-course-item": {
    rawText: "単品 1,800円 / コース 5,000円",
    claims: [
      claim("menu-course-item", budget(5000, 5000), "コース 5,000円", 0.88),
    ],
  },
  "menu-strikethrough": {
    rawText: "旧価格 3,000円（打消し） 現在 4,000円",
    claims: [
      claim("menu-strikethrough", budget(4000, 4000), "現在 4,000円", 0.86),
    ],
  },
  "menu-low-quality": {
    rawText: "価格は判読不十分",
    claims: [
      claim("menu-low-quality", budget(3000, 3000), "判読? 3000?", 0.42),
    ],
  },
};

export class MockOcrProvider implements OcrProvider {
  constructor(
    private readonly fixtures: Readonly<Record<string, MockOcrResponse>> =
      MOCK_OCR_FIXTURES,
  ) {}

  async extract(input: OcrInput, signal?: AbortSignal): Promise<OcrRunResult> {
    // fixture lookupより先に入力境界を通し、未許諾入力でも内部fixtureを参照しない。
    if (!validateOcrInput(input).ok) {
      return { status: "rejected", reason: "input_invalid", attempts: 0 };
    }
    const fileId = input.image.fileId;
    const fixture = fileId === undefined ? undefined : this.fixtures[fileId];
    if (!fixture) {
      // fixture ID 未知の場合は空結果に丸めず、実行失敗として明示する。
      return { status: "failed", reason: "unknown_fixture", attempts: 0 };
    }

    return await runOcrStructuredWithRetry(input, () => {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      return Promise.resolve(fixture);
    });
  }
}
