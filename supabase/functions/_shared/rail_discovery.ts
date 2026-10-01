import type { PlaceSearchResult } from "./providers/types.ts";

export function configuredPositiveInt(
  value: string | undefined,
): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function distanceM(
  leftLat: number | null,
  leftLng: number | null,
  rightLat: number | null,
  rightLng: number | null,
): number {
  if (
    leftLat === null || leftLng === null || rightLat === null ||
    rightLng === null
  ) return Number.POSITIVE_INFINITY;
  const radians = Math.PI / 180;
  const lat1 = leftLat * radians;
  const lat2 = rightLat * radians;
  const dLat = (rightLat - leftLat) * radians;
  const dLng = (rightLng - leftLng) * radians;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function preRankRailCandidates(
  candidates: Array<{ result: PlaceSearchResult; distanceM: number }>,
  broadLimit: number,
): PlaceSearchResult[] {
  return candidates
    .sort((left, right) =>
      left.distanceM - right.distanceM ||
      `${left.result.provider}\u0000${left.result.providerPlaceId}`
        .localeCompare(
          `${right.result.provider}\u0000${right.result.providerPlaceId}`,
        )
    )
    .slice(0, broadLimit)
    .map((entry) => entry.result);
}
