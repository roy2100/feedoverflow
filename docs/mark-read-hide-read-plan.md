# Plan: Mark All Read + Hide Read Articles

## Features

1. **Mark all as read** — 一键将当前视图所有文章标记为已读
2. **Hide read articles** — 切换隐藏/显示已读文章

---

## Feature 1: Mark All Read

### Backend

Add `POST /api/articles/read-all`:

```
Request body: { articles: Article[] }
Action: bulk upsert all articles with is_read=1
```

Use `better-sqlite3` transaction for atomicity:

```js
app.post('/api/articles/read-all', (req, res) => {
  const { articles } = req.body;
  if (!Array.isArray(articles)) return res.status(400).json({ error: 'articles required' });
  const markAll = db.transaction((list) => {
    for (const article of list) saveState(article, { is_read: 1 });
  });
  markAll(articles);
  res.json({ ok: true });
});
```

### Store (`store.js`)

Add `markAllRead()`:

```js
markAllRead: async () => {
  const { articles } = get();
  if (!articles.length) return;
  // optimistic update
  set(state => ({
    articles: state.articles.map(a => ({ ...a, isRead: true })),
    selectedArticle: state.selectedArticle
      ? { ...state.selectedArticle, isRead: true }
      : null,
  }));
  fetch(`${API}/articles/read-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles }),
  }).catch(console.error);
},
```

### UI (`ArticleList.jsx`)

Add a "Mark all read" button in the header toolbar (next to article count). Use `CheckCheck` icon from lucide-react.

- Disabled when no unread articles exist
- Calls `onMarkAllRead` prop → `markAllRead()` from store

---

## Feature 2: Hide Read Articles

### UI only — no backend changes needed

Local state in `ArticleList`:

```js
const [hideRead, setHideRead] = useState(false);
```

Filter before rendering:

```js
const visibleArticles = hideRead ? articles.filter(a => !a.isRead) : articles;
```

Toggle button in header. Use `EyeOff` / `Eye` icon from lucide-react. Button is highlighted (accent color) when active.

Article count shows filtered count when hideRead is on.

---

## Implementation Order

1. `server/index.js` — add `/api/articles/read-all` route
2. `client/src/store.js` — add `markAllRead` action
3. `client/src/components/ArticleList.jsx` — add both buttons + hideRead filter
4. `client/src/App.jsx` — pass `onMarkAllRead` prop to ArticleList
5. Mobile pages (`ListPage`) — same changes

---

## File Touch List

| File | Change |
|------|--------|
| `server/index.js` | Add `POST /api/articles/read-all` |
| `client/src/store.js` | Add `markAllRead` |
| `client/src/components/ArticleList.jsx` | Buttons + filter logic |
| `client/src/App.jsx` | Pass `markAllRead` as prop |
| `client/src/pages/ListPage.jsx` | Pass `markAllRead` as prop (mobile) |

---

## Edge Cases

- **Starred view**: mark-all still marks as read (stars are separate)
- **After mark-all + hide-read**: list becomes empty — show "暂无文章" placeholder
- **Articles with no DB row yet**: sending full article object to `/read-all` handles this via upsert
- **Concurrent loads**: optimistic update uses snapshot of articles at call time; no race issue because loadArticles resets state anyway
