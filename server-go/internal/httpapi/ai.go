package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
	"rss-reader/server-go/internal/translate"
)

// aiJobTimeout bounds one whole request: a long article on a local model is a
// few minutes of sequential pieces, and a client that closed the tab cancels
// r.Context() long before this fires.
const aiJobTimeout = 10 * time.Minute

// maxAITextBytes caps the request body. The reader sends the plain text it is
// showing, which for any real article is tens of KB; a megabyte is not an article.
const maxAITextBytes = 1 << 20

// aiEvent is one SSE frame. Exactly one of piece / done / error is meaningful per
// frame; `model` and `cached` ride on the done frame.
type aiEvent struct {
	Piece  string `json:"piece,omitempty"`
	Done   bool   `json:"done,omitempty"`
	Cached bool   `json:"cached,omitempty"`
	Model  string `json:"model,omitempty"`
	Error  string `json:"error,omitempty"`
}

// postArticleAI is POST /api/articles/:id/ai — an on-demand summary or body
// translation, streamed back as server-sent events and persisted in article_ai.
//
// The client sends the text, not the server reading article_states.content: what
// the reader is showing may be the Readability 全文, which is never persisted, and
// "translate what I am looking at" is the only behaviour that is not a surprise.
// The text is hashed; a stored row for (article, kind) with the same hash is
// replayed without a request, so re-opening an article costs nothing and loading
// 全文 after translating the RSS body regenerates rather than answering stale.
//
// Everything before the first event is an ordinary JSON status (400/404/503), so
// the client can branch on Content-Type. Once streaming starts, failure is an
// `error` event — the status line has already gone out as 200.
func (s *Server) postArticleAI(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Kind string `json:"kind"`
		Text string `json:"text"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAITextBytes)).Decode(&body)
	kind, ok := translate.ParseKind(body.Kind)
	if !ok {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "kind must be summary or translation"})
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "text required"})
		return
	}
	if s.BodyAI == nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "翻译服务未启用"})
		return
	}
	exists, err := store.ArticleExists(s.DB.Reader(), id)
	if err != nil {
		serverError(w, err)
		return
	}
	if !exists {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{"error": "article not found"})
		return
	}
	cfg, err := store.LLMConfig(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	// Ready, not Active: `enabled` is the *title worker's* intent switch. A click on
	// AI 摘要 is its own intent, and only needs the endpoint to be reachable.
	if !cfg.Conn.Ready() {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "请先在设置中配置翻译服务"})
		return
	}

	sum := sha256.Sum256([]byte(text))
	hash := hex.EncodeToString(sum[:16])

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	send := func(ev aiEvent) error {
		b, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := w.Write(append(append([]byte("data: "), b...), '\n', '\n')); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}

	cached, err := store.GetArticleAI(s.DB.Reader(), id, string(kind))
	if err != nil {
		_ = send(aiEvent{Error: "读取缓存失败"})
		return
	}
	if cached != nil && cached.SourceHash == hash {
		if err := send(aiEvent{Piece: cached.Content}); err != nil {
			return
		}
		_ = send(aiEvent{Done: true, Cached: true, Model: cached.Model})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), aiJobTimeout)
	defer cancel()

	var parts []string
	emit := func(piece string) error {
		parts = append(parts, piece)
		return send(aiEvent{Piece: piece})
	}
	switch kind {
	case translate.KindSummary:
		out, e := s.BodyAI.Summarize(ctx, cfg.Conn, text)
		if e == nil {
			e = emit(out)
		}
		err = e
	case translate.KindTranslation:
		err = s.BodyAI.TranslateBody(ctx, cfg.Conn, text, emit)
	}
	if err != nil {
		// The client may already be gone (emit failed); sending then fails too, which
		// is fine. Nothing is stored for a partial run — the next click retries from
		// scratch, and a retry is cheap next to a stored half-translation.
		_ = send(aiEvent{Error: userFacing(err)})
		return
	}
	content := strings.Join(parts, "\n\n")
	if err := store.SaveArticleAI(s.DB.Writer(), store.ArticleAI{
		ArticleID: id, Kind: string(kind), SourceHash: hash, Model: cfg.Conn.Model, Content: content,
	}); err != nil {
		// The user has the text on screen; losing the cache is a warning, not a failure.
		_ = send(aiEvent{Done: true, Model: cfg.Conn.Model})
		return
	}
	_ = send(aiEvent{Done: true, Model: cfg.Conn.Model})
}

// userFacing keeps upstream detail off the wire: the normalized translate errors
// are already user-facing; anything else (a wrapped connect error carrying a
// host name, a context deadline) is reduced to its normalized prefix or a
// generic line.
func userFacing(err error) string {
	for _, known := range []error{
		translate.ErrAuth, translate.ErrModel, translate.ErrConnect, translate.ErrUpstream,
		translate.ErrEmpty, translate.ErrAlreadyChinese,
	} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "生成超时"
	}
	if errors.Is(err, context.Canceled) {
		return "已取消"
	}
	return "生成失败"
}
