package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/store"
)

// getPushKey hands the client the VAPID public key it must pass to
// PushManager.subscribe(), generating the keypair on first request. Also reports
// whether any device is registered, so the UI can explain a feed toggle that is
// on but has nowhere to push.
func (s *Server) getPushKey(w http.ResponseWriter, _ *http.Request) {
	if s.Push == nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "push not configured",
		})
		return
	}
	key, err := s.Push.PublicKey()
	if err != nil {
		serverError(w, err)
		return
	}
	n, err := store.SubscriptionCount(s.DB.Reader())
	if err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"publicKey": key, "devices": n})
}

// subscriptionBody is the browser's PushSubscription.toJSON() shape, posted
// verbatim by the client.
type subscriptionBody struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// postPushSubscribe registers (or refreshes) this device's push endpoint.
func (s *Server) postPushSubscribe(w http.ResponseWriter, r *http.Request) {
	var body subscriptionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{
			"error": "endpoint and keys required",
		})
		return
	}
	sub := store.Subscription{
		Endpoint:  body.Endpoint,
		P256dh:    body.Keys.P256dh,
		Auth:      body.Keys.Auth,
		UserAgent: r.UserAgent(),
	}
	if err := store.SaveSubscription(s.DB.Writer(), sub, time.Now().UnixMilli()); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// postPushUnsubscribe drops one device's endpoint. Unknown endpoints are a no-op:
// the client's goal (this device receives nothing) is already satisfied.
func (s *Server) postPushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Endpoint == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "endpoint required"})
		return
	}
	if err := store.DeleteSubscription(s.DB.Writer(), body.Endpoint); err != nil {
		serverError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
