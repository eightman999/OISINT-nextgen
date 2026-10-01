import { describe, expect, it } from 'vitest';

import { mapActiveRestaurantImageKeys } from '../liveMapping';

describe('restaurant image catalog mapping', () => {
  it('fails open when the optional catalog lookup fails', () => {
    const keys = mapActiveRestaurantImageKeys(
      [{ image_key: 'demo-yakiniku-v1.jpg' }],
      true
    );

    expect(keys.size).toBe(0);
  });

  it('accepts only known bundled keys from a valid catalog response', () => {
    const keys = mapActiveRestaurantImageKeys([
      { image_key: 'demo-yakiniku-v1.jpg' },
      { image_key: 'demo-unknown-v1.jpg' },
      { image_key: 42 },
      null,
    ]);

    expect([...keys]).toEqual(['demo-yakiniku-v1.jpg']);
    expect(mapActiveRestaurantImageKeys(null).size).toBe(0);
  });
});
