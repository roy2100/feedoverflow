// Package mcp exposes the RSS reader's API over the Model Context Protocol
// (Streamable HTTP transport), mounted only on the loopback-only, no-auth
// listener (LOCAL_API_PORT). Port of server/mcp.ts (legacy_server_node branch).
//
// Tools reuse the HTTP API by calling it over loopback in this same process,
// same as the Node original: they target the no-auth loopback listener, not
// the public auth-gated one, so the calls carry no session cookie yet still
// pass — that is the whole point of the second listener.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// client calls the loopback API at http://127.0.0.1:<port>.
type client struct {
	baseURL string
	http    *http.Client
}

func newClient(port int) *client {
	return &client{baseURL: fmt.Sprintf("http://127.0.0.1:%d", port), http: http.DefaultClient}
}

func (c *client) request(ctx context.Context, method, path string, body any) (any, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		detail := string(data)
		if detail != "" {
			return nil, fmt.Errorf("HTTP %d %s %s: %s", res.StatusCode, method, path, detail)
		}
		return nil, fmt.Errorf("HTTP %d %s %s", res.StatusCode, method, path)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *client) get(ctx context.Context, path string) (any, error) {
	return c.request(ctx, http.MethodGet, path, nil)
}

func (c *client) post(ctx context.Context, path string, body any) (any, error) {
	if body == nil {
		body = map[string]any{}
	}
	return c.request(ctx, http.MethodPost, path, body)
}

func (c *client) patch(ctx context.Context, path string, body any) (any, error) {
	return c.request(ctx, http.MethodPatch, path, body)
}

func (c *client) delete(ctx context.Context, path string) (any, error) {
	return c.request(ctx, http.MethodDelete, path, nil)
}
