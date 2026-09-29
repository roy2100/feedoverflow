import type { SearchTab, View } from './types';

// The middle pane's header title. Desktop (App.tsx) and mobile (ListPage.tsx) both
// render that header, and each used to carry its own copy of this ladder — so a new
// view type could be added to one and silently render a blank header in the other,
// which is exactly what happened when collections shipped.
export function viewTitle(view: View): string {
  switch (view.type) {
    case 'all':
      return '全部';
    case 'today':
      return '今日';
    case 'starred':
      return '收藏';
    case 'podcast':
      return '播客';
    case 'search':
    case 'trend': // same query, other tab — the header's 结果 | 趋势 toggle tells them apart
      return `搜索：${view.query ?? ''}`;
    case 'collection':
      return view.collection?.name ?? '';
    case 'feed':
      return view.feed?.name ?? '';
  }
}

// Which 结果 | 趋势 tab the header toggle shows as active; undefined hides the toggle.
export function searchTabOf(view: View): SearchTab | undefined {
  if (view.type === 'search') return 'results';
  if (view.type === 'trend') return 'trend';
  return undefined;
}

// The list's empty-state line. Only a trend has something more useful to say than
// 暂无文章: that the window was searched and the term simply did not come up.
export function emptyTextOf(view: View): string | undefined {
  if (view.type === 'trend' && !view.day) {
    return `近 ${view.days ?? 30} 天没有提到「${view.query ?? ''}」的文章`;
  }
  return undefined;
}
