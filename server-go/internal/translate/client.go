package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxTitleRunes bounds both what is sent and what is stored, so a pathological
// feed item cannot inflate a request or a row.
const maxTitleRunes = 500

// maxGrowth rejects a runaway answer: a Chinese rendering of a headline is
// normally *shorter* than the original, so anything several times longer is the
// model explaining itself rather than translating. Treated as "nothing usable"
// (settled, not retried) rather than stored as a title.
const maxGrowth = 4

// systemPrompt is fixed instruction text. The title is passed as a separate user
// message and never concatenated into it: RSS titles are attacker-controlled, and
// keeping them out of the instruction channel is the whole mitigation. The blast
// radius if a title tries to redirect the model is one wrong headline string.
const systemPrompt = `You translate news headlines into Simplified Chinese.
Rules:
- Output ONLY the translated headline. No quotes, no explanation, no prefix.
- Keep product names, company names, version numbers and acronyms as-is.
- Preserve the terse register of a headline; do not add words that are not there.
- If the input is already Chinese, output it unchanged.`

// Client is the OpenAI-compatible chat-completions caller.
type Client struct {
	HTTP *http.Client
}

// New returns a Client with the request timeout the worker relies on: translation
// runs off the request path, but a hung endpoint must not stall a whole tick.
func New() *Client {
	return &Client{HTTP: &http.Client{Timeout: 30 * time.Second}}
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

// Translate implements Translator.
func (c *Client) Translate(ctx context.Context, cfg Config, title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", nil
	}
	in := truncateRunes(title, maxTitleRunes)

	body, err := json.Marshal(chatRequest{
		Model: cfg.Model,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: in},
		},
		Stream: false,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(cfg.BaseURL), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrConnect, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", statusError(resp.StatusCode)
	}
	var parsed chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	if len(parsed.Choices) == 0 {
		return "", nil
	}
	return clean(parsed.Choices[0].Message.Content, in), nil
}

// Check runs one real translation so the settings panel's 测试连接 exercises the
// exact path the worker will use, rather than a health endpoint that can pass
// while translation still fails (wrong model name, no chat permission, …).
func (c *Client) Check(ctx context.Context, cfg Config) error {
	if !cfg.Ready() {
		return ErrAuth
	}
	out, err := c.Translate(ctx, cfg, "Hello world")
	if err != nil {
		return err
	}
	if out == "" {
		return ErrUpstream
	}
	return nil
}

// endpoint joins the configured base with the chat-completions path. Bases are
// written both ways in the wild (`https://api.deepseek.com`,
// `https://api.moonshot.cn/v1`), so only the trailing slash is normalized — the
// `/v1` is the operator's to include or omit.
func endpoint(base string) string {
	return strings.TrimRight(base, "/") + "/chat/completions"
}

// statusError maps an HTTP status onto one of the normalized errors, so nothing
// from the upstream body can reach the browser through the test endpoint.
func statusError(code int) error {
	switch code {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrAuth
	case http.StatusNotFound, http.StatusBadRequest:
		// Both are how the OpenAI-compatible endpoints report an unknown model;
		// which one you get depends on the provider.
		return ErrModel
	default:
		return fmt.Errorf("%w (HTTP %d)", ErrUpstream, code)
	}
}

// clean strips the wrappers models add despite being told not to, and rejects an
// answer that grew far beyond the input (an explanation, not a translation).
// Returning "" means "settled, no translation" — the caller will not retry.
func clean(out, in string) string {
	out = strings.TrimSpace(out)
	out = strings.Trim(out, "\"'“”「」")
	out = strings.TrimSpace(out)
	if out == "" {
		return ""
	}
	if len([]rune(out)) > maxGrowth*len([]rune(in)) {
		return ""
	}
	return truncateRunes(out, maxTitleRunes)
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ValidateBaseURL gates what PATCH /api/llm/config will accept. Unlike the old
// plan's env var, base_url now arrives over HTTP, so it is restricted to https or
// a loopback host — the latter for local runtimes (Ollama, vLLM), which have no
// TLS and need none.
func ValidateBaseURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return fmt.Errorf("API 地址无效")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && isLoopback(u.Hostname()) {
		return nil
	}
	return fmt.Errorf("API 地址必须使用 https，或指向本机 (127.0.0.1 / localhost)")
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
