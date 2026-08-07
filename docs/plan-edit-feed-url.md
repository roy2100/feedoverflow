# 编辑订阅源 URL

## 目标

让一条订阅源可以改抓取地址，而**保留它已有的全部文章**。

现状：源死了只能删掉重加，而 `DeleteFeed` 会连带
`DELETE FROM article_states WHERE feed_id = ? AND is_starred = 0`
（`store/feeds_write.go:122`），未收藏的历史当场消失；收藏的行虽然留下，但
`AdoptStarredOrphans` 按 `feed_url` 匹配（`feeds_write.go:136`），换了 URL 就再也认领不回来，
只能从「收藏」里看到。

数据模型本来就支持无损换源：列表查询键的是 `feed_id`（`store.go:134`），而改 URL 不需要动
`feeds.id`。老文章仍归这条源，新 URL 抓回来的文章以同一个 `feed_id` 插入，两边重叠的文章
`article_id` 与 `feed_id` 都相同、走 upsert 正常刷新。**缺的只是一个 API 字段。**

## 范围

**做：**
- `PATCH /api/feeds/:id` 增加可选 `url` 字段
- 改 URL 时同步重写该源名下文章的 `feed_url`，并清空 `last_fetched_at`
- ManageFeedsModal 编辑态里 URL 可改
- `updateFeed` 检查响应状态（**现在不检查**，见风险 1）

**不做：**
- MCP 的 `rename_feed` 工具不加 `url`（13 个工具的形状不因此变；换源是人在 UI 里做的决定，
  不是 agent 该替人做的）
- 不动 `PersistItems` 的 upsert：`feed_id`/`feed_name`/`feed_url` 对**抓取**仍然是 insert-only。
  这里改的是 feed 自己的身份声明，不是让某次抓取去抢别人的文章行——两件事，别混。
- 不做「换源后自动比对新老源的重叠文章」之类的智能处理，upsert 天然处理

## 关键决定

### 1. 改 URL 时把该源文章的 `feed_url` 一并重写

```sql
UPDATE article_states SET feed_url = ? WHERE feed_id = ?
```

不重写也能正常读（列表只认 `feed_id`），但将来一旦删掉这条源再加回来，
`AdoptStarredOrphans` 会按新 URL 找孤儿、而老行还记着旧 URL，收藏就认领不回来了。
`feed_url` 的语义是「这篇文章所属源的地址」，源改了地址它就该跟着改。

与 `feed_url` 在 persist 里 insert-only 不冲突：那条规则挡的是**另一条源**的抓取把文章
改嫁走；这里是本源显式改自己的地址，和 `AdoptStarredOrphans` 显式改写 `feed_id`/`feed_name`
是同一类操作。

### 2. 同一事务里把 `last_fetched_at` 清成 NULL

不清的话这条源在 `CacheTTL = 5 * time.Minute`（`cache/cache.go:22`）内仍算新鲜，改完 URL
最多五分钟不会去新地址抓。

清成 NULL 后走 `EnsureFresh` 的 `last == 0 && hasRows` 分支（`cache.go:169-176`）：
**后台刷新**，不阻塞。历史立刻可读，新源的文章几秒后落库。不能让它走
`RefreshFeed` 那个 await 分支——那是给全新源第一次加载用的，这条源有历史，没有理由让用户干等。

### 3. 保存前先解析一次新 URL

和 POST 一样：`ResolveURL` → `parse`，失败返回 400 和同一句
「无法解析该 Feed，请检查 URL 是否正确」。代价是 PATCH 变成一次带网络的请求。

值得：换源的场景就是「老地址不灵了」，此时打错字的概率最高，而失败是静默的——源不再更新，
但界面上什么都看不出来，等发现时已经过了几天。

### 4. URL 没变就整条跳过

客户端可能把整个 patch 原样发回来。`url` 与当前值相同时不查重、不解析、不写库，
避免一次白跑的网络请求。

### 5. 冲突判定要排除自己

`FeedURLExists` 对「就是本源当前的 URL」也返回 true，不能直接用。新增
`FeedURLTakenByOther(r, url, id)`：`SELECT 1 FROM feeds WHERE url = ? AND id <> ?`，
命中返回 409。`IsUniqueViolation` 仍作为并发兜底。

## 步骤

1. **`store/feeds_write.go`** — 加 `FeedURLTakenByOther`；加 `UpdateFeedURL(w, id, url)`：
   一个事务里 `UPDATE feeds SET url = ?, last_fetched_at = NULL WHERE id = ?` +
   `UPDATE article_states SET feed_url = ? WHERE feed_id = ?`，返回 feeds 行的 RowsAffected
   （0 = 404）。
2. **`httpapi/feeds.go`** — `patchFeed` 加 `URL *string`；空 body 的 400 分支要把 `url` 算进去。
   顺序：先取当前行（`GetFeed`，顺带 404）→ URL 分支（查重 / 解析 / 写库）→ 再 name → 再 push。
   URL 是唯一会因网络失败的一步，放最前面，失败时 name 不会已经被改掉。
3. **`httpapi/feeds_test.go`** — 新增：
   - `TestFeedURLEdit`：改 URL 后 `feeds.url` 变了、`last_fetched_at` 为 NULL、
     该源老文章的 `feed_url` 被重写、文章一条没少（**这条是本次改动的核心断言**）
   - `TestFeedURLEditRejected`：占用中的 URL → 409；解析失败 → 400；空串 → 400；
     且被拒后 `feeds.url` 和文章都没动
   - `TestFeedURLEditNoop`：URL 未变时不调用 parse（用计数的 fake）
4. **`client/src/types.ts`** — `FeedPatch` 加 `url?: string`
5. **`client/src/store.ts`** — `updateFeed` 检查 `r.ok`，失败抛服务端 `error` 文案；
   成功后再合并本地状态（现在是无条件合并，见风险 1）
6. **`client/src/components/ManageFeedsModal.tsx`** — 编辑态由一个输入框变成两个（名称 / 地址），
   只提交真正改动的字段；保存失败时行内红字显示原因，且不退出编辑态
7. **`client/src/__tests__/ManageFeedsModal.test.tsx`** — 改 URL 提交 `{url}`；
   只改名字仍只提交 `{name}`；保存失败时留在编辑态并显示错误
8. **`CLAUDE.md`** — API 表里 `PATCH /api/feeds/:id` 一行改成「rename / 改地址 / 切换
   `push_enabled`（均可选）」，并在 Server 小节补一句换源为什么不丢历史
9. `cd server-go && make check`；`cd client && npm test && npm run typecheck`；
   `npm run fmt && npm run lint`

## 风险与未决

1. **`updateFeed` 目前不检查响应**（`store.ts:292`）——`await apiFetch(...)` 之后直接把 patch
   合并进本地状态。改名失败也是静默的，只是改名几乎不会失败所以没暴露。加了 URL 之后失败是
   常态路径（打错字、源不可达），必须修。这会让 `updateFeed` 从「不会 reject」变成「会 reject」，
   调用方 `handleTogglePush` 已经 try/catch（`ManageFeedsModal.tsx:111`），`handleSave` 需要补。
2. **改 URL 不会补抓新源的历史文章**。新源只返回它当前窗口里的那些条目，
   老源与新源之间的空档期没有任何东西能填。这是 RSS 的固有限制，不是本次能解决的。
3. **重叠文章的归属**：如果新 URL 的文章已经被**第三条**源抢先插入过，那些行仍归第三条源
   （persist 的 insert-only 规则），换源后这条源不会显示它们。这正是 zaobao 那次遇到的情况，
   与本改动无关，属于「同一版面别订两条源」的既有约束。
4. `feeds.url` 上有唯一索引，但 `rsshub://a/b` 与其展开后的 `http://host/a/b` 是两个不同字符串，
   查重查不出来。既有 POST 也是这个行为，本次不扩大范围。

## 复杂度

**Medium** — 后端逻辑短且局部，但跨 server/client/docs 三处，且要顺带修一个既有的静默失败
（风险 1）。

## Outcome

九个步骤全部按计划完成，无偏离。`make check` 与 `npm test`（217 个）/ `typecheck` / `fmt:check`
/ `lint` 全绿。

改动：

| 文件 | 内容 |
|---|---|
| `store/feeds_write.go` | `FeedURLTakenByOther`、`UpdateFeedURL`（一个事务：改 url + 清 `last_fetched_at` + 重写该源文章的 `feed_url`） |
| `httpapi/feeds.go` | `patchFeed` 加 `URL *string`；新增 `applyFeedURL`（查重 / 解析 / 写库，失败即返回） |
| `httpapi/feeds_test.go` | `TestFeedURLEdit`、`TestFeedURLEditRejected`、`TestFeedURLEditNoop`，外加可计数、可失败的 `stubParse` |
| `client/src/types.ts` | `FeedPatch.url?` |
| `client/src/store.ts` | `updateFeed` 检查 `r.ok` 并抛错 |
| `ManageFeedsModal.tsx` | 编辑态两个输入框（名称 / 地址）+ 行内错误，只提交改动字段 |
| `__tests__/ManageFeedsModal.test.tsx` | 三个用例：只改地址 / 只改名 / 被拒后留在编辑态 |
| `CLAUDE.md` | API 表 + Server 小节的换源说明 |

两点实现时才定下来的细节：

- `applyFeedURL` 拆成独立方法而不是塞进 `patchFeed`，因为它有六个提前返回；用返回 `bool`
  表示「响应是否已写出」，让 `patchFeed` 里只多一行。
- 客户端在**发送前**就比对旧值，只提交真正变了的字段。服务端已经会把「URL 没变」当 no-op，
  这一层是为了让改名请求的 body 里根本不出现 `url`——否则日志里每次改名都像一次换源。

未做（计划里已列为不做）：MCP 的 `rename_feed` 不加 `url`；`rsshub://a/b` 与其展开地址
仍算两个不同的 URL，查重查不出来。
