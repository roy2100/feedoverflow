const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'RSS-Reader/1.0' },
  customFields: {
    item: [['media:thumbnail', 'thumbnail'], ['content:encoded', 'contentEncoded']],
  },
});

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'feeds.json');

const DEFAULT_FEEDS = [
  { id: '1', name: '少数派', url: 'https://sspai.com/feed', category: '科技' },
  { id: '2', name: '虎嗅', url: 'https://feeds.feedburner.com/huxiu', category: '科技' },
  { id: '3', name: '36氪', url: 'https://36kr.com/feed', category: '财经' },
  { id: '4', name: '阮一峰的网络日志', url: 'https://feeds.feedburner.com/ruanyifeng', category: '技术' },
];

function loadFeeds() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_FEEDS, null, 2));
  return DEFAULT_FEEDS;
}

function saveFeeds(feeds) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(feeds, null, 2));
}

// GET /api/feeds
app.get('/api/feeds', (req, res) => {
  const feeds = loadFeeds();
  res.json(feeds);
});

// POST /api/feeds
app.post('/api/feeds', (req, res) => {
  const { url, name, category } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const feeds = loadFeeds();
  const id = Date.now().toString();
  const newFeed = { id, name: name || url, url, category: category || '未分类' };
  feeds.push(newFeed);
  saveFeeds(feeds);
  res.json(newFeed);
});

// DELETE /api/feeds/:id
app.delete('/api/feeds/:id', (req, res) => {
  const feeds = loadFeeds();
  const idx = feeds.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Feed not found' });
  feeds.splice(idx, 1);
  saveFeeds(feeds);
  res.json({ ok: true });
});

// GET /api/feeds/:id/articles
app.get('/api/feeds/:id/articles', async (req, res) => {
  const feeds = loadFeeds();
  const feed = feeds.find(f => f.id === req.params.id);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });

  try {
    const parsed = await parser.parseURL(feed.url);
    const articles = parsed.items.slice(0, 50).map((item, i) => ({
      id: `${feed.id}-${i}`,
      title: item.title || 'Untitled',
      summary: item.contentSnippet || item.summary || '',
      content: item.contentEncoded || item.content || item.summary || '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      author: item.creator || item.author || '',
    }));
    res.json({ feedName: parsed.title || feed.name, articles });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feed', detail: err.message });
  }
});

// GET /api/all-articles  — aggregated unread view (first 5 from each feed)
app.get('/api/all-articles', async (req, res) => {
  const feeds = loadFeeds();
  const results = await Promise.allSettled(
    feeds.map(async feed => {
      const parsed = await parser.parseURL(feed.url);
      return parsed.items.slice(0, 5).map((item, i) => ({
        id: `${feed.id}-${i}`,
        feedId: feed.id,
        feedName: feed.name,
        title: item.title || 'Untitled',
        summary: item.contentSnippet || '',
        content: item.contentEncoded || item.content || item.summary || '',
        link: item.link || '',
        pubDate: item.pubDate || item.isoDate || '',
      }));
    })
  );

  const articles = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  res.json({ articles });
});

const PORT = 3002;
app.listen(PORT, () => console.log(`RSS server running on http://localhost:${PORT}`));
