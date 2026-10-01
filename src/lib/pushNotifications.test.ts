import { describe, expect, it, vi } from 'vitest';

import {
  parsePushNotificationData,
  PushIdentityController,
} from '@/lib/pushNotifications';

const INVESTIGATION_ID = '00000000-0000-4000-8000-000000000540';
const NOTIFICATION_ID = '00000000-0000-4000-8000-000000000541';

describe('push notification privacy contract (#540)', () => {
  it('accepts only a fixed investigation route and safe metadata', () => {
    expect(parsePushNotificationData({
      schema: 'oisint.push.v1',
      eventType: 'investigation_completed',
      investigationId: INVESTIGATION_ID,
      notificationId: NOTIFICATION_ID,
      route: `/investigations/${INVESTIGATION_ID}`,
    })).toEqual({
      schema: 'oisint.push.v1',
      eventType: 'investigation_completed',
      investigationId: INVESTIGATION_ID,
      notificationId: NOTIFICATION_ID,
      route: `/investigations/${INVESTIGATION_ID}`,
    });
  });

  it.each([
    { rawQuery: '個室でアレルギー対応' },
    { authToken: 'secret' },
    { tasteProfile: ['spicy'] },
    { restaurantName: '秘密の店' },
  ])('rejects an extra sensitive field: %o', (extra) => {
    expect(parsePushNotificationData({
      schema: 'oisint.push.v1',
      eventType: 'group_update',
      investigationId: INVESTIGATION_ID,
      notificationId: NOTIFICATION_ID,
      route: `/investigations/${INVESTIGATION_ID}`,
      ...extra,
    })).toBeNull();
  });

  it('rejects query strings, fragments, and another investigation route', () => {
    for (const route of [
      `/investigations/${INVESTIGATION_ID}?token=secret`,
      `/investigations/${INVESTIGATION_ID}#top3`,
      '/investigations/00000000-0000-4000-8000-000000000999',
      'https://attacker.example/investigations/1',
    ]) {
      expect(parsePushNotificationData({
        schema: 'oisint.push.v1',
        eventType: 'ranking_changed',
        investigationId: INVESTIGATION_ID,
        notificationId: NOTIFICATION_ID,
        route,
      })).toBeNull();
    }
  });
});

describe('PushIdentityController', () => {
  it('logs out the old subject before an account switch', async () => {
    const calls: string[] = [];
    const provider = {
      login: vi.fn(async (id: string) => { calls.push(`login:${id}`); }),
      logout: vi.fn(async () => { calls.push('logout'); }),
    };
    const controller = new PushIdentityController(provider);

    await controller.sync('account-a');
    await controller.sync('account-b');

    expect(calls).toEqual(['login:account-a', 'logout', 'login:account-b']);
    expect(controller.current()).toBe('account-b');
  });

  it('serializes concurrent switches and detaches on logout', async () => {
    const calls: string[] = [];
    const provider = {
      login: async (id: string) => { calls.push(`login:${id}`); },
      logout: async () => { calls.push('logout'); },
    };
    const controller = new PushIdentityController(provider);

    await Promise.all([
      controller.sync('account-a'),
      controller.sync('account-b'),
      controller.sync(null),
    ]);

    expect(calls).toEqual([
      'login:account-a',
      'logout',
      'login:account-b',
      'logout',
    ]);
    expect(controller.current()).toBeNull();
  });

  it('recovers from a failed login by detaching the possibly linked identity first', async () => {
    const calls: string[] = [];
    let first = true;
    const provider = {
      login: vi.fn(async (id: string) => {
        calls.push(`login:${id}`);
        if (first) {
          first = false;
          throw new Error('provider detail must not poison the queue');
        }
      }),
      logout: vi.fn(async () => { calls.push('logout'); }),
    };
    const controller = new PushIdentityController(provider);

    await expect(controller.sync('account-a')).rejects.toThrow();
    await controller.sync('account-b');

    expect(calls).toEqual(['login:account-a', 'logout', 'login:account-b']);
    expect(controller.current()).toBe('account-b');
  });
});
