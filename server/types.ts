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
}

export interface FeedCacheRow {
  feed_id: string;
  feed_name: string;
  items_json: string;
  fetched_at: number;
}

export interface StatePatch {
  is_starred?: number | null;
}
