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
  isRead: boolean;
  isStarred: boolean;
}

// Which list is shown in the middle panel. `feed` is present only for `type: 'feed'`,
// `query` only for `type: 'search'`.
export interface View {
  type: 'all' | 'today' | 'starred' | 'feed' | 'search';
  feed?: Feed;
  query?: string;
}

// Mobile single-pane navigation.
export type MobilePage = 'feeds' | 'list' | 'article';

// Value carried by AudioContext (audio player wiring owned by App).
export interface AudioCtxValue {
  audioRef: React.RefObject<HTMLAudioElement>;
  currentEpisode: Article | null;
  isPlaying: boolean;
  onPlay: (article: Article) => void;
  onTogglePlay: () => void;
  onClosePlayer: () => void;
}
