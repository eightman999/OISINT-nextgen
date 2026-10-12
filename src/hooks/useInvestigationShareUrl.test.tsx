// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useInvestigationShareUrl } from '@/hooks/useInvestigationShareUrl';

const tokenA = 'a'.repeat(32);
const tokenB = 'b'.repeat(32);
const tokenC = 'c'.repeat(32);
const tokenD = 'd'.repeat(32);
const url = (token: string) => `https://oisint.com/i/${token}`;
const initial = {
  investigationId: 'inv-1',
  subjectKey: 'member-a',
  paramToken: tokenA,
  investigationShareToken: tokenB as string | undefined,
};

afterEach(cleanup);

describe('investigation share URL', () => {
  it('copies/encodes the canonical token rather than a mismatched route parameter', () => {
    const { result } = renderHook(() => useInvestigationShareUrl(initial));
    expect(result.current.shareUrl).toBe(url(tokenB));
  });

  it('uses the route only while no canonical token is available', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, {
      initialProps: { ...initial, investigationShareToken: undefined as string | undefined },
    });
    expect(result.current.shareUrl).toBe(url(tokenA));
    rerender(initial);
    expect(result.current.shareUrl).toBe(url(tokenB));
  });

  it('uses canonical data after reload with an old route token', () => {
    const first = renderHook(() => useInvestigationShareUrl(initial));
    act(() => first.result.current.onRotated(tokenC));
    first.unmount();
    const next = renderHook(() => useInvestigationShareUrl({ ...initial, investigationShareToken: tokenC }));
    expect(next.result.current.shareUrl).toBe(url(tokenC));
  });

  it('reflects a rotation on another device without a local rotation', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    rerender({ ...initial, investigationShareToken: tokenC });
    expect(result.current.shareUrl).toBe(url(tokenC));
  });

  it('keeps the successful rotation across missing and delayed old snapshots', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    act(() => result.current.onRotated(tokenC));
    expect(result.current.shareUrl).toBe(url(tokenC));
    rerender({ ...initial, investigationShareToken: undefined });
    expect(result.current.shareUrl).toBe(url(tokenC));
    rerender(initial);
    expect(result.current.shareUrl).toBe(url(tokenC));
    rerender({ ...initial, investigationShareToken: tokenC });
    rerender(initial);
    expect(result.current.shareUrl).toBe(url(tokenC));
  });

  it('accepts a subsequent canonical rotation and rejects known superseded snapshots', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    act(() => result.current.onRotated(tokenC));
    rerender({ ...initial, investigationShareToken: tokenD });
    expect(result.current.shareUrl).toBe(url(tokenD));
    rerender({ ...initial, investigationShareToken: tokenC });
    expect(result.current.shareUrl).toBe(url(tokenD));
    rerender(initial);
    expect(result.current.shareUrl).toBe(url(tokenD));
  });

  it('supports repeated local rotations while old snapshots remain in flight', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    act(() => result.current.onRotated(tokenC));
    act(() => result.current.onRotated(tokenD));
    rerender({ ...initial, investigationShareToken: tokenC });
    expect(result.current.shareUrl).toBe(url(tokenD));
    rerender(initial);
    expect(result.current.shareUrl).toBe(url(tokenD));
  });

  it.each(['investigationId', 'subjectKey'] as const)('resets rotation at the %s boundary and rejects delayed completion', (field) => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    const oldCompletion = result.current.onRotated;
    act(() => oldCompletion(tokenC));
    rerender({ ...initial, [field]: 'different', investigationShareToken: tokenD });
    expect(result.current.shareUrl).toBe(url(tokenD));
    act(() => oldCompletion(tokenC));
    expect(result.current.shareUrl).toBe(url(tokenD));
    rerender(initial);
    act(() => oldCompletion(tokenC));
    expect(result.current.shareUrl).toBe(url(tokenB));
  });

  it('does not let a changed route override a successful rotation', () => {
    const { result, rerender } = renderHook(useInvestigationShareUrl, { initialProps: initial });
    act(() => result.current.onRotated(tokenC));
    rerender({ ...initial, paramToken: tokenD });
    expect(result.current.shareUrl).toBe(url(tokenC));
  });

  it('does not replace a canonical token with an empty rotation response', () => {
    const { result } = renderHook(() => useInvestigationShareUrl(initial));
    act(() => result.current.onRotated(''));
    expect(result.current.shareUrl).toBe(url(tokenB));
  });
});
