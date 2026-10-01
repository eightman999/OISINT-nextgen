export function parsePublicHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

// model-derived Evidence is shared across investigations. Query strings and
// fragments can contain requirement text or access tokens, so do not persist
// them in that cross-investigation asset.
export function isSafeModelNeutralSharedUrl(raw: string): boolean {
  const parsed = parsePublicHttpUrl(raw);
  return parsed !== null && parsed.search === "" && parsed.hash === "";
}
