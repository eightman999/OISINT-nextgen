// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isPwaRegistrationAllowed,
  PwaRuntime,
  registerPwaServiceWorker,
} from '@/components/PwaRuntime';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PwaRuntime', () => {
  it('production WebのHTTPSまたはloopbackだけを登録対象にする', () => {
    const base = {
      platform: 'web',
      nodeEnv: 'production',
      protocol: 'https:',
      hostname: 'oisint.com',
      hasServiceWorker: true,
    };

    expect(isPwaRegistrationAllowed(base)).toBe(true);
    expect(isPwaRegistrationAllowed({ ...base, nodeEnv: 'test' })).toBe(false);
    expect(isPwaRegistrationAllowed({ ...base, platform: 'ios' })).toBe(false);
    expect(
      isPwaRegistrationAllowed({ ...base, protocol: 'http:', hostname: 'example.com' }),
    ).toBe(false);
    expect(
      isPwaRegistrationAllowed({ ...base, protocol: 'http:', hostname: '127.0.0.1' }),
    ).toBe(true);
    expect(isPwaRegistrationAllowed({ ...base, hasServiceWorker: false })).toBe(false);
  });

  it('同一scopeの既存登録があれば二重登録せず、無ければroot scopeへ登録する', async () => {
    const existing = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue({} as ServiceWorkerRegistration);
    const existingContainer = {
      getRegistration: vi.fn().mockResolvedValue(existing),
      register,
    };

    await expect(registerPwaServiceWorker(existingContainer)).resolves.toBe(existing);
    expect(existingContainer.getRegistration).toHaveBeenCalledWith('/');
    expect(register).not.toHaveBeenCalled();

    const freshRegistration = {} as ServiceWorkerRegistration;
    const freshContainer = {
      getRegistration: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(freshRegistration),
    };
    await expect(registerPwaServiceWorker(freshContainer)).resolves.toBe(freshRegistration);
    expect(freshContainer.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('offline時は調査データを取得できないことと再試行を表示し、onlineで消える', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    try {
      const { getByTestId, queryByTestId } = render(<PwaRuntime />);
      expect(getByTestId('pwa-offline-notice').textContent).toContain('新しい調査データは取得できません');
      expect(getByTestId('pwa-offline-retry').textContent).toBe('再試行');

      fireEvent.click(getByTestId('pwa-offline-retry'));
      expect(getByTestId('pwa-offline-notice')).toBeTruthy();

      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(queryByTestId('pwa-offline-notice')).toBeNull();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'onLine', originalDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'onLine');
      }
    }
  });
});
