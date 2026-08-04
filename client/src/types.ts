// Shared client types. `Feed` / `Article` mirror the server's `server/types.ts`.

export interface Feed {
  id: string;
  name: string;
  url: string;
  /** Per-feed Web Push opt-in. Absent on responses from an older server. */
  push_enabled?: boolean;
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
  // Epoch ms of the last genuine upstream content edit; null/absent when never edited since
  // first fetch. The reader shows an "更新于" time only when this is set.
  updatedAt?: number | null;
}

// One clause of a collection: `feed AND include AND NOT exclude`. An empty `feedId` means
// any feed, an empty `include` means no keyword requirement. A rule with neither is
// rejected by the server — it would select the whole table, i.e. a slow copy of 全部.
export interface CollectionRule {
  feedId: string;
  include: string;
  exclude: string;
}

// A named stream assembled from several feeds: its articles are the *union* of its rules.
// A collection is a saved query over the articles already stored, not a source — it fetches
// nothing, and deleting one removes no articles.
export interface Collection {
  id: string;
  name: string;
  rules: CollectionRule[];
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
// `collection` only for `type: 'collection'`, `query` / `scope` only for `type: 'search'`.
export interface View {
  type: 'all' | 'today' | 'starred' | 'podcast' | 'feed' | 'collection' | 'search';
  feed?: Feed;
  collection?: Collection;
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
  isBuffering: boolean;
  onPlay: (article: Article) => void;
  onTogglePlay: () => void;
  onClosePlayer: () => void;
}
