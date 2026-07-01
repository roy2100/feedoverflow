// Package httpx holds small HTTP helpers shared across the API packages.
package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// WriteJSON encodes v with HTML escaping disabled so &, <, > pass through raw,
// matching Node's JSON.stringify / Express res.json.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		http.Error(w, `{"error":"encode failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}
