export interface Feed {
  id: string;
  name: string;
  url: string;
  // Epoch ms of the last successful upstream fetch; drives refresh scheduling. Null/absent
  // until a feed has been fetched at least once (replaces the old feed_cache.fetched_at).
  last_fetched_at?: number | null;
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

export interface ArticleStateRow {
  article_id: string;
  feed_id: string;
  feed_name: string;
  title: string;
  link: string;
  pub_date: string;
  summary: string;
  content: string;
  author: string;
  audio_url: string;
  audio_duration: string;
  is_starred: number;
  updated_at: string;
  // Publish time as epoch ms (parsed from pub_date, else fetch time). Sortable, unlike the
  // RFC-822 pub_date text. Absent only on rows inserted by tests via raw SQL.
  pub_ts?: number;
}

export interface StatePatch {
  is_starred?: number | null;
}
