import { recognizePreferenceContexts } from '@/lib/behaviorRecognition';
import {
  PREFERENCE_CONTEXTS,
  type PreferenceContext,
} from '@/lib/preferenceLearning';
import { matchCanonicalTasteSignals } from '@/lib/tasteTaxonomy';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 5000;
const MAX_FIELD_LENGTH = 1000;

export interface InferredTasteSignal {
  label: string;
  matches: number;
  confidence: number;
  origins: ('explicit_tag' | 'list_name' | 'text_match')[];
  contexts: PreferenceContext[];
}

export interface GoogleMapsImportSummary {
  format: 'csv' | 'json';
  recordCount: number;
  inferredLikes: InferredTasteSignal[];
  discardedDetailFields: number;
  warnings: string[];
}

export type GoogleMapsImportErrorCode =
  | 'unsupported_file'
  | 'too_large'
  | 'location_history'
  | 'invalid_file'
  | 'no_records';

export class GoogleMapsImportError extends Error {
  constructor(
    public readonly code: GoogleMapsImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleMapsImportError';
  }
}

interface ImportRecord {
  searchableText: string;
  contextText: string;
  explicitTagText: string;
  listNameText: string;
  discardedDetailFields: number;
}

const TEXT_FIELD_NAMES = new Set([
  'title',
  'name',
  'place name',
  'note',
  'notes',
  'comment',
  'comments',
  'description',
  'タイトル',
  '名前',
  'メモ',
  'コメント',
]);

// Store names and titles can contain words such as "家族" without describing the user's
// situation. Only free-form note/comment fields may contribute textual context evidence.
const CONTEXT_TEXT_FIELD_NAMES = new Set([
  'note',
  'notes',
  'comment',
  'comments',
  'description',
  'メモ',
  'コメント',
]);

const TAG_FIELD_NAMES = new Set(['tag', 'tags', 'タグ']);
const LIST_FIELD_NAMES = new Set(['list', 'list name', 'リスト', 'リスト名']);

const DETAIL_FIELD_NAMES = new Set([
  'url',
  'link',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'coordinates',
  'geometry',
  'address',
  '住所',
]);

export function parseGoogleMapsTakeout(
  text: string,
  fileName: string,
): GoogleMapsImportSummary {
  assertSafeFile(text, fileName);
  const extension = fileName.toLowerCase().split('.').pop();
  let format: GoogleMapsImportSummary['format'];
  let records: ImportRecord[];

  if (extension === 'csv') {
    format = 'csv';
    records = parseSavedCsv(text, fileName);
  } else if (extension === 'json' || extension === 'geojson') {
    format = 'json';
    records = parseSavedJson(text, fileName);
  } else {
    throw new GoogleMapsImportError(
      'unsupported_file',
      'CSVまたはJSON形式の「Saved」書き出しを選んでください。',
    );
  }

  if (records.length === 0) {
    throw new GoogleMapsImportError('no_records', '保存済み項目を確認できませんでした。');
  }

  const inferredLikes = inferTasteSignals(records, fileName);
  const warnings = [
    '店舗名・URL・住所・座標・メモ本文は結果に保持しません。',
    inferredLikes.length > 0
      ? '明示タグ・リスト名・語句の一致を分け、同じ項目にある粗い利用場面も共起として推定しています。内容は保存前に確認してください。'
      : '好みの傾向を十分に推定できませんでした。元ファイルは保持されません。',
  ];

  return {
    format,
    recordCount: records.length,
    inferredLikes,
    discardedDetailFields: records.reduce(
      (total, record) => total + record.discardedDetailFields,
      0,
    ),
    warnings,
  };
}

export function selectInferredTasteLabels(
  summary: GoogleMapsImportSummary,
  selectedLabels: readonly string[],
): string[] {
  return selectInferredTasteSignals(summary, selectedLabels).map((signal) => signal.label);
}

export function selectInferredTasteSignals(
  summary: GoogleMapsImportSummary,
  selectedLabels: readonly string[],
): InferredTasteSignal[] {
  const selected = new Set(selectedLabels);
  return summary.inferredLikes.filter((signal) => selected.has(signal.label));
}

function assertSafeFile(text: string, fileName: string): void {
  if (utf8ByteLength(text) > MAX_IMPORT_BYTES) {
    throw new GoogleMapsImportError('too_large', 'ファイルは5MB以下にしてください。');
  }

  const name = fileName.toLowerCase();
  const looksLikeTimelineName =
    /location.?history|semantic.?location|timeline|ロケーション履歴|タイムライン/.test(name);
  const looksLikeTimelineContent =
    /"(?:timelineObjects|activitySegment|placeVisit|semanticSegments|timelinePath)"\s*:/.test(text) ||
    (/"latitudeE7"\s*:/.test(text) && /"timestamp(?:Ms)?"\s*:/.test(text));

  if (looksLikeTimelineName || looksLikeTimelineContent) {
    throw new GoogleMapsImportError(
      'location_history',
      'ロケーション履歴・タイムラインは対象外です。「Saved」の保存済みリストだけを書き出してください。',
    );
  }
}

function parseSavedCsv(text: string, _fileName: string): ImportRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeader);
  const hasSavedHeader = headers.some(
    (header) =>
      TEXT_FIELD_NAMES.has(header) ||
      TAG_FIELD_NAMES.has(header) ||
      LIST_FIELD_NAMES.has(header) ||
      header === 'url' ||
      header === 'link',
  );
  if (!hasSavedHeader) {
    throw new GoogleMapsImportError(
      'invalid_file',
      'Google Takeoutの「Saved」CSVとして確認できませんでした。',
    );
  }

  const records: ImportRecord[] = [];
  for (const row of rows.slice(1, MAX_RECORDS + 1)) {
    if (row.every((field) => !field.trim())) continue;
    const searchable: string[] = [];
    const contextual: string[] = [];
    const explicitTags: string[] = [];
    const listNames: string[] = [];
    let discardedDetailFields = 0;

    for (let index = 0; index < Math.min(headers.length, row.length, 50); index += 1) {
      const header = headers[index];
      const value = row[index]?.trim();
      if (!value) continue;
      if (TEXT_FIELD_NAMES.has(header)) searchable.push(value.slice(0, MAX_FIELD_LENGTH));
      if (CONTEXT_TEXT_FIELD_NAMES.has(header)) contextual.push(value.slice(0, MAX_FIELD_LENGTH));
      if (TAG_FIELD_NAMES.has(header)) explicitTags.push(value.slice(0, MAX_FIELD_LENGTH));
      if (LIST_FIELD_NAMES.has(header)) listNames.push(value.slice(0, MAX_FIELD_LENGTH));
      if (DETAIL_FIELD_NAMES.has(header)) discardedDetailFields += 1;
    }

    records.push({
      searchableText: searchable.join(' '),
      contextText: contextual.join(' '),
      explicitTagText: explicitTags.join(' '),
      listNameText: listNames.join(' '),
      discardedDetailFields,
    });
  }

  if (rows.length - 1 > MAX_RECORDS) {
    throw new GoogleMapsImportError(
      'too_large',
      `一度に確認できる保存項目は${MAX_RECORDS}件までです。`,
    );
  }

  return records;
}

function parseSavedJson(text: string, _fileName: string): ImportRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GoogleMapsImportError('invalid_file', 'JSONファイルを読み取れませんでした。');
  }

  const geoJsonRecords = parseGeoJsonFeatures(parsed);
  if (geoJsonRecords) return geoJsonRecords;

  const records: ImportRecord[] = [];
  const queue: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  let queueIndex = 0;
  let visited = 0;

  while (queueIndex < queue.length && records.length <= MAX_RECORDS) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current || current.depth > 7) continue;
    visited += 1;
    if (visited > 30_000) {
      throw new GoogleMapsImportError('too_large', 'JSONの項目数が上限を超えています。');
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;

    const object = current.value as Record<string, unknown>;
    const searchable: string[] = [];
    const contextual: string[] = [];
    const explicitTags: string[] = [];
    const listNames: string[] = [];
    let discardedDetailFields = 0;
    let resemblesPlace = false;

    for (const [rawKey, value] of Object.entries(object).slice(0, 100)) {
      const key = normalizeHeader(rawKey);
      if (TEXT_FIELD_NAMES.has(key) && typeof value === 'string') {
        resemblesPlace = true;
        searchable.push(value.slice(0, MAX_FIELD_LENGTH));
        if (CONTEXT_TEXT_FIELD_NAMES.has(key)) {
          contextual.push(value.slice(0, MAX_FIELD_LENGTH));
        }
      } else if (TAG_FIELD_NAMES.has(key)) {
        const values = boundedTextValues(value);
        if (values.length > 0) resemblesPlace = true;
        explicitTags.push(...values);
      } else if (LIST_FIELD_NAMES.has(key)) {
        const values = boundedTextValues(value);
        if (values.length > 0) resemblesPlace = true;
        listNames.push(...values);
      } else if (DETAIL_FIELD_NAMES.has(key)) {
        discardedDetailFields += 1;
        if (key === 'geometry' || key === 'coordinates') resemblesPlace = true;
      }

      if (value && typeof value === 'object') {
        queue.push({ value, depth: current.depth + 1 });
      }
    }

    if (
      resemblesPlace &&
      (searchable.length > 0 || explicitTags.length > 0 || listNames.length > 0 || discardedDetailFields > 0)
    ) {
      records.push({
        searchableText: searchable.join(' '),
        contextText: contextual.join(' '),
        explicitTagText: explicitTags.join(' '),
        listNameText: listNames.join(' '),
        discardedDetailFields,
      });
    }
  }

  if (records.length > MAX_RECORDS) {
    throw new GoogleMapsImportError(
      'too_large',
      `一度に確認できる保存項目は${MAX_RECORDS}件までです。`,
    );
  }
  return deduplicateNestedJsonRecords(records);
}

function parseGeoJsonFeatures(parsed: unknown): ImportRecord[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const features = (parsed as Record<string, unknown>).features;
  if (!Array.isArray(features)) return null;
  if (features.length > MAX_RECORDS) {
    throw new GoogleMapsImportError(
      'too_large',
      `一度に確認できる保存項目は${MAX_RECORDS}件までです。`,
    );
  }

  return features.flatMap((feature): ImportRecord[] => {
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return [];
    const object = feature as Record<string, unknown>;
    const properties =
      object.properties && typeof object.properties === 'object' && !Array.isArray(object.properties)
        ? (object.properties as Record<string, unknown>)
        : object;
    const searchable: string[] = [];
    const contextual: string[] = [];
    const explicitTags: string[] = [];
    const listNames: string[] = [];
    let discardedDetailFields = object.geometry ? 1 : 0;

    for (const [rawKey, value] of Object.entries(properties).slice(0, 100)) {
      const key = normalizeHeader(rawKey);
      if (TEXT_FIELD_NAMES.has(key) && typeof value === 'string') {
        searchable.push(value.slice(0, MAX_FIELD_LENGTH));
        if (CONTEXT_TEXT_FIELD_NAMES.has(key)) {
          contextual.push(value.slice(0, MAX_FIELD_LENGTH));
        }
      }
      if (TAG_FIELD_NAMES.has(key)) {
        explicitTags.push(...boundedTextValues(value));
      }
      if (LIST_FIELD_NAMES.has(key)) {
        listNames.push(...boundedTextValues(value));
      }
      if (DETAIL_FIELD_NAMES.has(key) && value != null) discardedDetailFields += 1;
    }

    if (
      searchable.length === 0 &&
      explicitTags.length === 0 &&
      listNames.length === 0 &&
      discardedDetailFields === 0
    ) return [];
    return [{
      searchableText: searchable.join(' '),
      contextText: contextual.join(' '),
      explicitTagText: explicitTags.join(' '),
      listNameText: listNames.join(' '),
      discardedDetailFields,
    }];
  });
}

function inferTasteSignals(records: ImportRecord[], fileName: string): InferredTasteSignal[] {
  interface SignalAccumulator {
    recordIndexes: Set<number>;
    origins: Set<InferredTasteSignal['origins'][number]>;
    contextRecordIndexes: Record<PreferenceContext, Set<number>>;
  }
  const signals = new Map<string, SignalAccumulator>();

  const addMatches = (
    text: string,
    origin: InferredTasteSignal['origins'][number],
    recordIndex: number,
    contexts: readonly PreferenceContext[],
  ) => {
    for (const match of matchCanonicalTasteSignals(text.slice(0, 5000))) {
      const current = signals.get(match.label) ?? {
        recordIndexes: new Set<number>(),
        origins: new Set<InferredTasteSignal['origins'][number]>(),
        contextRecordIndexes: Object.fromEntries(
          PREFERENCE_CONTEXTS.map((context) => [context, new Set<number>()]),
        ) as Record<PreferenceContext, Set<number>>,
      };
      current.recordIndexes.add(recordIndex);
      current.origins.add(origin);
      if (recordIndex >= 0) {
        contexts.forEach((context) => current.contextRecordIndexes[context].add(recordIndex));
      }
      signals.set(match.label, current);
    }
  };

  records.forEach((record, index) => {
    const contexts = recognizePreferenceContexts(
      `${record.contextText} ${record.explicitTagText} ${record.listNameText}`,
    );
    addMatches(record.searchableText, 'text_match', index, contexts);
    addMatches(record.explicitTagText, 'explicit_tag', index, contexts);
    addMatches(record.listNameText, 'list_name', index, contexts);
  });

  // A cuisine-specific filename is treated as a list name, never as an individual place record.
  addMatches(fileName.slice(0, 120), 'list_name', -1, []);

  return [...signals.entries()]
    .map(([label, accumulator]) => {
      const origins = [...accumulator.origins];
      const recordMatches = [...accumulator.recordIndexes].filter((index) => index >= 0).length;
      const matches = Math.max(1, recordMatches);
      const baseConfidence = origins.includes('explicit_tag')
        ? 0.9
        : origins.includes('list_name')
          ? 0.72
          : 0.45;
      const confidence = Math.min(
        0.98,
        baseConfidence + Math.min(0.08, (matches - 1) * 0.015),
      );
      return {
        label,
        matches,
        confidence: Math.round(confidence * 100) / 100,
        origins: origins.sort(originOrder),
        contexts: PREFERENCE_CONTEXTS.filter((context) => {
          const contextualMatches = accumulator.contextRecordIndexes[context].size;
          // One context-like record must not contaminate a mostly general tag. A context is
          // retained only when it describes at least half of that tag's matching records.
          return contextualMatches > 0 && contextualMatches / recordMatches >= 0.5;
        }),
      };
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        right.matches - left.matches ||
        left.label.localeCompare(right.label, 'ja'),
    )
    .slice(0, 12);
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new GoogleMapsImportError('invalid_file', 'CSVの引用符が閉じていません。');
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function deduplicateNestedJsonRecords(records: ImportRecord[]): ImportRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.searchableText}\0${record.contextText}\0${record.explicitTagText}\0${record.listNameText}\0${record.discardedDetailFields}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function originOrder(
  left: InferredTasteSignal['origins'][number],
  right: InferredTasteSignal['origins'][number],
): number {
  const order: Record<InferredTasteSignal['origins'][number], number> = {
    explicit_tag: 0,
    list_name: 1,
    text_match: 2,
  };
  return order[left] - order[right];
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function boundedTextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value.slice(0, MAX_FIELD_LENGTH)];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 50)
    .map((item) => item.slice(0, MAX_FIELD_LENGTH));
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}
