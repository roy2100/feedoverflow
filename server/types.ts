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
  // Epoch ms of the last genuine upstream content edit (see persistItems). Null when the
  // article has never been edited since first fetch — the UI shows an "updated" time only
  // when this is set.
  updatedAt?: number | null;
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
  // Epoch ms of the last genuine upstream content edit; NULL until first edited. Absent on
  // rows inserted by tests via raw SQL.
  content_updated_at?: number | null;
  // Publish time as epoch ms (parsed from pub_date, else fetch time). Sortable, unlike the
  // RFC-822 pub_date text. Absent only on rows inserted by tests via raw SQL.
  pub_ts?: number;
}

export interface StatePatch {
  is_starred?: number | null;
}
