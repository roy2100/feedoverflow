import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useMobilePanelHistory } from '../hooks/useMobilePanelHistory';

const realUserAgent = navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  // Reset to a single history entry so each test starts at the root panel.
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  setUserAgent(realUserAgent);
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

  it('does not re-lay entries the open app already has below it', async () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));
    act(() => result.current.navigate('list'));

    // A notification can arrive while the app is already partway down the stack.
    // Only 文章 is missing here; laying the whole hierarchy down again would bury
    // the user's own entries and make back replay 列表 → 订阅源 twice.
    act(() => result.current.openDeepLinked());
    expect(result.current.page).toBe('article');

    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('list'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
    // Nothing left below: the next back leaves the app, as it would have before
    // the notification arrived.
    expect(window.history.length).toBe(3);
  });

  it('adds no entry when the deep link lands on an article already open', () => {
    const { result } = renderHook(() => useMobilePanelHistory(true));
    act(() => result.current.navigate('list'));
    act(() => result.current.navigate('article'));
    const before = window.history.length;

    // Reading an article and being pushed another one swaps the content, not the
    // stack — the reader entry is already the top of it.
    act(() => result.current.openDeepLinked());

    expect(result.current.page).toBe('article');
    expect(window.history.length).toBe(before);
  });

  it('animates the forward push but not an iOS swipe-back', async () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    const { result } = renderHook(() => useMobilePanelHistory(true));

    // Going deeper is a tap with no native gesture — keep the CSS slide.
    act(() => result.current.navigate('list'));
    expect(result.current.instant).toBe(false);

    // The edge-swipe already animated the back navigation; ours must not run a
    // second, competing slide over it (the overlap this fixes).
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
    expect(result.current.instant).toBe(true);
  });

  it('keeps the slide on back for non-iOS (Android)', async () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120');
    const { result } = renderHook(() => useMobilePanelHistory(true));

    act(() => result.current.navigate('list'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.page).toBe('feeds'));
    // No native back-gesture on Android — the CSS slide is the only motion.
    expect(result.current.instant).toBe(false);
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
