// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HelpLauncher } from '@/components/HelpLauncher';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: { push: mocks.push },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('HelpLauncher', () => {
  it('opens an accessible sheet and returns focus after Escape', async () => {
    const onEvent = vi.fn();
    const { getByTestId, queryByTestId } = render(<HelpLauncher onEvent={onEvent} />);
    const trigger = getByTestId('help-launcher-trigger');

    expect(trigger.getAttribute('aria-label')).toBe('ヘルプとサポートを開く');
    trigger.focus();
    fireEvent.click(trigger);

    const sheet = getByTestId('help-launcher-sheet');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('help-launcher-close')));

    fireEvent.keyDown(document, { key: 'Escape' });
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(queryByTestId('help-launcher-sheet')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('help-launcher-trigger')));

    expect(onEvent).toHaveBeenCalledWith({ name: 'help_launcher_impression' });
    expect(onEvent).toHaveBeenCalledWith({ name: 'help_launcher_opened' });
    expect(onEvent).toHaveBeenCalledWith({ name: 'help_sheet_closed' });
    expect(onEvent.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ query: expect.anything(), body: expect.anything() }),
    );
  });

  it('traps Tab focus at both ends of the sheet', async () => {
    const { getByTestId } = render(<HelpLauncher />);
    fireEvent.click(getByTestId('help-launcher-trigger'));
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('help-launcher-close')));

    const close = getByTestId('help-launcher-close');
    const lastLink = getByTestId('help-launcher-link-contact');
    lastLink.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastLink);
  });

  it('closes through browser Back and routes each destination after the sheet closes', async () => {
    const onEvent = vi.fn();
    const { getByTestId, queryByTestId } = render(<HelpLauncher onEvent={onEvent} />);

    for (const destination of ['help', 'support', 'feedback', 'contact'] as const) {
      fireEvent.click(getByTestId('help-launcher-trigger'));
      fireEvent.click(getByTestId(`help-launcher-link-${destination}`));
      window.dispatchEvent(new PopStateEvent('popstate'));

      await waitFor(() => expect(queryByTestId('help-launcher-sheet')).toBeNull());
      expect(mocks.push).toHaveBeenLastCalledWith({ pathname: `/${destination}` });
      expect(onEvent).toHaveBeenCalledWith({
        name: 'help_link_clicked',
        destination,
      });
    }
  });
});
