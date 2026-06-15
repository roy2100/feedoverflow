# Plan: PC 阅读体验优化

## Goal
在桌面网页端进一步提升阅读体验。当前 reader 已较完善（serif 正文 16px/1.85、680/820 限宽居中、HTML 内容样式齐全、方向键 + Esc 导航），本文档登记一批候选优化项，供后续挑选实现。状态：**待决策，尚未实现。**

## Scope
- 包含：reader 面板（`ArticleReader.tsx`）的桌面阅读交互与排版优化。
- 不包含：移动端单页（`pages/`）、sidebar / article-list 宽度（上一轮已调整为 260 / 380）、后端与数据层。

## Current State（基线，便于回溯）
- 正文样式 `articleContentStyle`：`font-serif`、`fontSize: 16`、`lineHeight: 1.85`（`ArticleReader.tsx:681`）
- 限宽：普通 680 / 专注阅读 820，居中（`ArticleReader.tsx:242`）
- 操作按钮（star / 专注阅读 / 加载全文 / 原文）位于 meta 行内，会随正文滚动消失（`ArticleReader.tsx:280–485`）
- 键盘导航：←/→ 切换文章、Esc 退出专注（`App.tsx:78–94`）
- 字体变量 `--font-serif: 'Noto Serif SC', 'Georgia', serif`（`index.css:24`）
- 正文 HTML 样式注入：`.rss-article *`（`ArticleReader.tsx:693+`）

## Candidate Items（按 价值/成本 排序）

### 高价值
1. **粘性操作栏** — meta 行内的 star / 专注阅读 / 加载全文 / 原文 会随正文滚走，长文需滚回顶部才能操作。改为 reader 面板内一条纤细 sticky header（feed 名 + 这些按钮），固定不动。桌面端实用性最高。
2. **阅读进度条** — reader 顶部一条 2–3px accent 进度条，跟随滚动位置。成本低（`scrollRef` 上一个 scroll 监听），对加载全文后的长文尤其有用。
3. **阅读时长估算** — meta 行日期旁显示「~5 min read」或中文字数。由 `rawContent` 长度计算，零依赖，提供「现在要不要看」的判断信号。

### 中价值
4. **排版收紧** — `lineHeight: 1.85`（`ArticleReader.tsx:684`）对 680 限宽偏松，可收到 **1.7–1.75**；宽屏正文可升至 **17px**；加 `text-rendering: optimizeLegibility` + `-webkit-font-smoothing: antialiased`。主观项，建议出 before/after 对比再定。
5. **正文图片 点击放大 + 懒加载** — `.rss-article img` 当前为静态。桌面端点击放大（lightbox）符合预期，`loading="lazy"` 避免长文加载卡顿；同时对正文链接强制 `target="_blank"`（当前继承源站设置）。

### 低价值 / 打磨
6. **更多键盘导航** — 现有 ←/→/Esc，可加 `j`/`k`（vim）、`Space`/`Shift+Space` 翻页；可选 `s` 收藏、`f` 专注。面向重度用户。
7. **切换文章滚动复位** — 需验证 `selectedArticle` 变化时滚动是否干净复位（代码中未确认）。
8. **代码块换行/溢出** — `pre` 当前横向溢出，可选优化，较小众。

## 推荐组合
**1 + 2 + 3** 同做，提升最明显且低风险；如需可叠加排版项（#4）做 before/after 对比。

## Risks & Open Questions
- #1 sticky 栏的高度与 padding 需与现有 48px 顶部留白协调，避免遮挡标题。
- #4 行高/字号为主观偏好，定稿前需用户确认对比稿。
- #3 中英文混排时「字数 vs 分钟数」口径需确定（中文按字数、英文按词数估时？）。
- #7 滚动复位行为待先验证再决定是否需要改动。

## Estimated Complexity
Low–Medium —单项均为局部改动，集中在 `ArticleReader.tsx`（#6 在 `App.tsx`）；无后端/数据层影响。

## Outcome
（实现后补充）
