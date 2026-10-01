import type { Evidence } from '@/types';

export function safePublicEvidenceUrl(raw: string): string | undefined {
  const candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) return undefined;
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return undefined;
  try {
    const parsed = new URL(candidate);
    if (!['https:', 'http:'].includes(parsed.protocol)) return undefined;
    if (!parsed.hostname || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function isEvidenceSafeForDisplay(evidence: Evidence): boolean {
  const safeUrl = safePublicEvidenceUrl(evidence.sourceUrl);
  if (!safeUrl) return false;
  if (evidence.scope !== 'shared' || evidence.sourceType === 'major_place_provider') {
    return true;
  }
  const parsed = new URL(safeUrl);
  return parsed.search === '' && parsed.hash === '';
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function prepareEvidenceForDisplay(rows: readonly Evidence[]): Evidence[] {
  return rows
    .filter(isEvidenceSafeForDisplay)
    .slice()
    .sort((a, b) => {
      const observed = compareCodeUnits(b.observedAt, a.observedAt);
      return observed || compareCodeUnits(a.id, b.id);
    });
}
