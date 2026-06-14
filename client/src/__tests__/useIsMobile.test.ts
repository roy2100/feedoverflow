import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';

import { useIsMobile } from '../hooks/useIsMobile';

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

afterEach(() => {
  setWidth(1024); // restore jsdom default
});

describe('useIsMobile', () => {
  it('returns false on a wide viewport (> 768)', () => {
    setWidth(1200);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('returns true on a narrow viewport (< 768)', () => {
    setWidth(375);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('treats exactly 768 as mobile (boundary)', () => {
    setWidth(768);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('updates when the window is resized', () => {
    setWidth(1200);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      setWidth(400);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(true);

    act(() => {
      setWidth(1000);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(false);
  });

  it('removes the resize listener on unmount', () => {
    setWidth(1200);
    const { result, unmount } = renderHook(() => useIsMobile());
    unmount();

    // After unmount the stale hook must not react to resize events.
    act(() => {
      setWidth(400);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(false);
  });
});
