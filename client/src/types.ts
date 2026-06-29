// Shared client types. `Feed` / `Article` mirror the server's `server/types.ts`.

export interface Feed {
  id: string;
  name: string;
  url: string;
}

export interface Article {
  id: string;
  feedId: string;
  feedName: string;
  title: string;
  summary: string;
  content: string;
  link: string;
  pubDate: string;
  author: string;
  audioUrl: string;
  audioDuration: string;
  isStarred: boolean;
}

// Optional scope on a search view: restrict results to starred articles or one feed.
// Captured from the base view (Starred / a specific feed) active before search began.
// `全部/All` and `Today` are not scopable, so they never produce a scope.
export interface SearchScope {
  kind: 'starred' | 'feed';
  feedId?: string;
  feedName?: string;
}

// Which list is shown in the middle panel. `feed` is present only for `type: 'feed'`,
// `query` / `scope` only for `type: 'search'`.
export interface View {
  type: 'all' | 'today' | 'starred' | 'podcast' | 'feed' | 'search';
  feed?: Feed;
  query?: string;
  scope?: SearchScope;
}

// Mobile single-pane navigation.
export type MobilePage = 'feeds' | 'list' | 'article';

// Ordering for the merged multi-feed lists (全部 / 今日):
// `latest` = strict global newest-first; `digest` = per-feed quota so every feed is represented.
export type ListMode = 'latest' | 'digest';

// Value carried by AudioContext (audio player wiring owned by App).
export interface AudioCtxValue {
  audioRef: React.RefObject<HTMLAudioElement>;
  currentEpisode: Article | null;
  isPlaying: boolean;
  onPlay: (article: Article) => void;
  onTogglePlay: () => void;
  onClosePlayer: () => void;
}
