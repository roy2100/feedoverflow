import { useEffect, useState } from 'react';

import type { MobilePage } from '../types';

// Panel nesting depth — the hierarchy both the slide animation and the history
// stack derive from.
export const PANEL_DEPTH: Record<MobilePage, number> = { feeds: 0, list: 1, article: 2 };

// iOS's left-edge swipe-back is a native, gesture-driven visual handling of the
// same-document history navigation; our own translateX transition then animates a
// second time on `popstate`, and a fast swipe freezes the two into an overlap. On
// iOS we therefore snap backward changes to their final transform (no CSS slide)
// and let the gesture be the only animation. Everything else keeps the slide.
function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as desktop Safari; a touch-capable "Mac" is really an iPad.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

interface PanelState {
  page: MobilePage;
  // Whether this change should render without the CSS slide (see detectIOS).
  instant: boolean;
}

/**
 * Mirrors the mobile panel stack into browser history.
 *
 * The three panels are a navigation hierarchy (订阅源 → 列表 → 文章) drawn with a
 * push/pop slide animation, and that visual grammar promises back-navigability —
 * so the system back button and edge-swipe have to walk it rather than exit the
 * app. Going deeper pushes an entry; going shallower asks the browser to pop, so
 * the stack never accumulates entries that no longer match a visible panel, and
 * `popstate` is the single place a panel change is applied.
 *
 * Inert on desktop: that layout shows all three panes at once and has nothing to
 * pop.
 */
export function useMobilePanelHistory(isMobile: boolean) {
  const [isIOS] = useState(detectIOS);
  const [state, setState] = useState<PanelState>({ page: 'feeds', instant: false });
  const page = state.page;

  useEffect(() => {
    if (!isMobile) return;
    if (!window.history.state?.page) {
      window.history.replaceState({ page: 'feeds' }, '');
    }
    const onPop = (e: PopStateEvent) => {
      const next = (e.state as { page?: MobilePage } | null)?.page ?? 'feeds';
      // On iOS the swipe gesture already animated this; skip our CSS slide so it
      // doesn't run a second, competing animation on top.
      setState({ page: next, instant: isIOS });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile, isIOS]);

  const navigate = (next: MobilePage) => {
    if (next === page) return;
    if (!isMobile) {
      setState({ page: next, instant: false });
      return;
    }
    if (PANEL_DEPTH[next] > PANEL_DEPTH[page]) {
      // Going deeper is a plain tap with no native gesture behind it — animate.
      window.history.pushState({ page: next }, '');
      setState({ page: next, instant: false });
      return;
    }
    // Shallower: hand it to history, so the in-app arrow and the system back
    // button take exactly the same path. popstate applies it.
    window.history.back();
  };

  /**
   * Lay down the entries the user never walked through, so back pops
   * 文章 → 列表 → 订阅源 even though a notification tap put them on the deepest
   * panel in one step — Android's TaskStackBuilder parent stack, iOS's
   * setViewControllers.
   *
   * Only the entries *missing* below the reader get pushed. A notification can
   * arrive while the app is already open and already somewhere in the stack, and
   * blanket-rewriting the current entry with 订阅源 does not replace what is
   * underneath it — `replaceState` touches one entry — it buries it, leaving
   * 订阅源 → 列表 → 订阅源 → 列表 → 文章. Back then replays panels the user
   * already passed, which reads as broken and invites the extra swipe that
   * finally exits the document.
   */
  const openDeepLinked = () => {
    if (!isMobile) {
      setState({ page: 'article', instant: false });
      return;
    }
    // The current entry is itself a panel of the same hierarchy, so everything
    // shallower than it is already on the stack.
    if (PANEL_DEPTH[page] < PANEL_DEPTH.list) window.history.pushState({ page: 'list' }, '');
    if (PANEL_DEPTH[page] < PANEL_DEPTH.article) window.history.pushState({ page: 'article' }, '');
    // A one-step jump to the deepest panel — there is no slide to honor.
    setState({ page: 'article', instant: true });
  };

  return { page, instant: state.instant, navigate, openDeepLinked };
}
