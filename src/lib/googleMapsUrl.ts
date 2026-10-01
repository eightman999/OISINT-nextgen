import type { Place } from '@/types';

const GOOGLE_PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function normalizeGooglePlaceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  return GOOGLE_PLACE_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function googleMapsUrlForPlace(place: Pick<Place, 'name' | 'address' | 'googlePlaceId'>): string {
  const query = place.address?.trim() || place.name.trim();
  const base = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const placeId = normalizeGooglePlaceId(place.googlePlaceId);
  return placeId ? `${base}&query_place_id=${encodeURIComponent(placeId)}` : base;
}

export function googleMapsDirectionsUrlForPlace(
  place: Pick<Place, 'name' | 'address' | 'googlePlaceId' | 'lat' | 'lng'>,
): string {
  const destination =
    typeof place.lat === 'number' && typeof place.lng === 'number'
      ? `${place.lat},${place.lng}`
      : place.address?.trim() || place.name.trim();
  const base = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
  const placeId = normalizeGooglePlaceId(place.googlePlaceId);
  return placeId ? `${base}&destination_place_id=${encodeURIComponent(placeId)}` : base;
}
