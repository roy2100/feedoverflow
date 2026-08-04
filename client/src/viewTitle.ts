import type { View } from './types';

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
      return `搜索：${view.query ?? ''}`;
    case 'collection':
      return view.collection?.name ?? '';
    case 'feed':
      return view.feed?.name ?? '';
  }
}
