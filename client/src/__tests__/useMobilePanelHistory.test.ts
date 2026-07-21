import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useMobilePanelHistory } from '../hooks/useMobilePanelHistory';

beforeEach(() => {
  // Reset to a single history entry so each test starts at the root panel.
  window.history.replaceState(null, '', '/');
});

describe('useMobilePanelHistory on mobile', () => {
  it('walks back through the hierarchy instead of leaving the app', async () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));

    act(() => result.current.navigate('list'));
    act(() => result.current.navigate('article'));
    expect(result.current.page).toBe('article');

    // Two system-back presses must retrace 文章 → 列表 → 订阅源, matching the
    // push/pop slide the panels animate.
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('list'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
  });

  it('routes the in-app back arrow through history too', async () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));
    act(() => result.current.navigate('list'));
    act(() => result.current.navigate('article'));

    act(() => result.current.navigate('list'));

    // Going shallower must pop rather than push: otherwise the stack grows
    // entries that no longer match a visible panel, and the system back button
    // would replay panels the user already left.
    await waitFor(() => expect(result.current.page).toBe('list'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
  });

  it('synthesizes the full stack for a deep-linked article', async () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));

    act(() => result.current.openDeepLinked());
    expect(result.current.page).toBe('article');

    // A notification tap lands on the deepest panel in one step, but back must
    // still walk the hierarchy the user never went through, rather than exiting
    // the app on the first press.
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('list'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
  });

  it('ignores navigation to the panel already shown', () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));
    act(() => result.current.navigate('list'));
    const before = window.history.length;

    act(() => result.current.navigate('list'));

    expect(window.history.length).toBe(before);
    expect(result.current.page).toBe('list');
  });
});

describe('useMobilePanelHistory on desktop', () => {
  it('changes panels without touching history', () => {
    const { result } = renderHook(() => useMobilePanelHistory(false));
    const before = window.history.length;

    act(() => result.current.navigate('article'));

    // The desktop layout shows all three panes at once — there is nothing to pop,
    // and pushing entries would hijack the browser's own back button.
    expect(result.current.page).toBe('article');
    expect(window.history.length).toBe(before);
  });
});
