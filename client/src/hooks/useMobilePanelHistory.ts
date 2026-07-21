import { useEffect, useState } from 'react';

import type { MobilePage } from '../types';

// Panel nesting depth — the hierarchy both the slide animation and the history
// stack derive from.
export const PANEL_DEPTH: Record<MobilePage, number> = { feeds: 0, list: 1, article: 2 };

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
  const [page, setPage] = useState<MobilePage>('feeds');

  useEffect(() => {
    if (!isMobile) return;
    if (!window.history.state?.page) {
      window.history.replaceState({ page: 'feeds' }, '');
    }
    const onPop = (e: PopStateEvent) => {
      setPage((e.state as { page?: MobilePage } | null)?.page ?? 'feeds');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile]);

  const navigate = (next: MobilePage) => {
    if (next === page) return;
    if (!isMobile) {
      setPage(next);
      return;
    }
    if (PANEL_DEPTH[next] > PANEL_DEPTH[page]) {
      window.history.pushState({ page: next }, '');
      setPage(next);
      return;
    }
    // Shallower: hand it to history, so the in-app arrow and the system back
    // button take exactly the same path. popstate applies it.
    window.history.back();
  };

  /**
   * Lay down the entries the user never walked through, so back pops
   * 文章 → 列表 → 订阅源 → exit even though a notification tap put them on the
   * deepest panel in one step. Replacing what was there — rather than appending
   * to it — is what Android's TaskStackBuilder does when rebuilding a task for a
   * deep link, and what iOS's setViewControllers does to a navigation stack.
   */
  const openDeepLinked = () => {
    if (!isMobile) {
      setPage('article');
      return;
    }
    window.history.replaceState({ page: 'feeds' }, '');
    window.history.pushState({ page: 'list' }, '');
    window.history.pushState({ page: 'article' }, '');
    setPage('article');
  };

  return { page, navigate, openDeepLinked };
}
