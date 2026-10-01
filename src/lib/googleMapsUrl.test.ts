import { describe, expect, it } from 'vitest';

import {
  googleMapsDirectionsUrlForPlace,
  googleMapsUrlForPlace,
  normalizeGooglePlaceId,
} from '@/lib/googleMapsUrl';

describe('Google Maps candidate URLs', () => {
  it('targets an exact candidate only when an explicit valid Place ID exists', () => {
    expect(googleMapsUrlForPlace({
      name: '店A',
      address: '東京都豊島区1-2-3',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    })).toBe(
      'https://www.google.com/maps/search/?api=1&query=%E6%9D%B1%E4%BA%AC%E9%83%BD%E8%B1%8A%E5%B3%B6%E5%8C%BA1-2-3&query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
  });

  it('falls back to an encoded query instead of guessing from an unsafe identifier', () => {
    expect(googleMapsUrlForPlace({
      name: '店 A',
      googlePlaceId: 'https://maps.google.com/private?id=secret',
    })).toBe('https://www.google.com/maps/search/?api=1&query=%E5%BA%97%20A');
    expect(normalizeGooglePlaceId('ChIJ valid with spaces')).toBeUndefined();
  });
});

describe('Google Maps directions URLs', () => {
  it('routes to precise coordinates when lat/lng are available, keeping the Place ID', () => {
    expect(googleMapsDirectionsUrlForPlace({
      name: '店A',
      address: '東京都豊島区1-2-3',
      lat: 35.7294985567,
      lng: 139.712846869,
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=35.7294985567%2C139.712846869&destination_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
  });

  it('falls back to the address (then name) when coordinates are missing', () => {
    expect(googleMapsDirectionsUrlForPlace({
      name: '店A',
      address: '東京都豊島区1-2-3',
    })).toBe('https://www.google.com/maps/dir/?api=1&destination=%E6%9D%B1%E4%BA%AC%E9%83%BD%E8%B1%8A%E5%B3%B6%E5%8C%BA1-2-3');
    expect(googleMapsDirectionsUrlForPlace({
      name: '店 A',
    })).toBe('https://www.google.com/maps/dir/?api=1&destination=%E5%BA%97%20A');
  });

  it('drops an unsafe identifier instead of guessing a Place ID', () => {
    expect(googleMapsDirectionsUrlForPlace({
      name: '店 A',
      googlePlaceId: 'https://maps.google.com/private?id=secret',
    })).toBe('https://www.google.com/maps/dir/?api=1&destination=%E5%BA%97%20A');
  });
});
