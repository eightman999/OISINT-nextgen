/**
 * Search-origin distances belong to the transient discovery result, not the
 * shared canonical place. Copy at the write boundary so pre-ranking can still
 * use the original metadata without exposing the searcher's location.
 */
export function canonicalPlaceMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const canonical = { ...metadata };
  delete canonical.distanceM;
  return canonical;
}
