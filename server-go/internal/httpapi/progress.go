package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
)

// Podcast playback positions: /api/podcast-progress. The position used to live in
// the browser's localStorage; it lives in article_states now so a resume survives
// a data wipe and follows the listener to their other devices. Rationale and the
// division of labour with the client: docs/plan-podcast-progress-sqlite.md.

// progressLimit bounds the GET: the client hydrates an in-memory map from it once
// at startup and only ever resumes recently-played episodes.
const progressLimit = 200

func (s *Server) getPodcastProgress(w http.ResponseWriter, _ *http.Request) {
	progress, err := store.PlaybackProgress(s.DB.Reader(), progressLimit)
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"progress": progress})
}

// postPodcastProgress records one episode's position. `duration` is accepted (so
// the wire format is self-describing) but unused: whether an episode is close
// enough to its end to count as finished is decided client-side, where the audio
// element's live duration is, and the client sends DELETE rather than POST in that
// case. This handler only ever stores a position worth resuming.
func (s *Server) postPodcastProgress(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID       string  `json:"id"`
		Position float64 `json:"position"`
		Duration float64 `json:"duration"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "id required"})
		return
	}
	if math.IsNaN(body.Position) || math.IsInf(body.Position, 0) || body.Position <= 0 {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "position must be > 0"})
		return
	}
	seconds := int(math.Round(body.Position))
	if err := store.SavePlaybackProgress(
		s.DB.Writer(), body.ID, seconds, time.Now().UnixMilli(),
	); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "position": seconds})
}

func (s *Server) deletePodcastProgress(w http.ResponseWriter, r *http.Request) {
	if err := store.ClearPlaybackProgress(s.DB.Writer(), chi.URLParam(r, "id")); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
