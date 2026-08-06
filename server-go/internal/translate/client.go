package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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
// It is kept terse on purpose: it is resent on every request (one title per call),
// so every token here is paid ~400 times a day.
const systemPrompt = `Translate the news headline to Simplified Chinese.
Reply with the translation only — no quotes, no explanation.
Keep names, versions and acronyms as-is. If already Chinese, echo it.`

// Client is the OpenAI-compatible chat-completions caller.
type Client struct {
	HTTP *http.Client
	// Log, when set, records the token usage each endpoint reports. Translation is
	// the only thing here that costs money per item, and the split between prompt
	// and completion tokens is the only way to tell an expensive prompt from a
	// model that is thinking out loud. nil in tests.
	Log *slog.Logger
}

// New returns a Client with the request timeout the worker relies on: translation
// runs off the request path, but a hung endpoint must not stall a whole tick.
func New(log *slog.Logger) *Client {
	return &Client{HTTP: &http.Client{Timeout: 30 * time.Second}, Log: log}
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
		Message struct {
			Content string `json:"content"`
			// ReasoningContent is DeepSeek's field for chain-of-thought. It is never
			// used as the translation — it is read only so the log can say how much of
			// the completion went to thinking rather than to the answer.
			ReasoningContent string `json:"reasoning_content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
		// DeepSeek reports prefix-cache hits here; an identical system prompt on
		// every call should be landing in it.
		PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
	} `json:"usage"`
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
	c.logUsage(parsed, in)
	if len(parsed.Choices) == 0 {
		return "", nil
	}
	return clean(parsed.Choices[0].Message.Content, in), nil
}

// logUsage records what one translation cost. `reasoning` is the length of any
// chain-of-thought the model returned: on a task this small it is the difference
// between ~100 tokens a call and several hundred, and it is invisible in a
// provider dashboard that only reports totals.
func (c *Client) logUsage(r chatResponse, in string) {
	if c.Log == nil {
		return
	}
	reasoning := 0
	if len(r.Choices) > 0 {
		reasoning = len([]rune(r.Choices[0].Message.ReasoningContent))
	}
	c.Log.Info("translate usage",
		"promptTokens", r.Usage.PromptTokens,
		"completionTokens", r.Usage.CompletionTokens,
		"totalTokens", r.Usage.TotalTokens,
		"cacheHitTokens", r.Usage.PromptCacheHitTokens,
		"reasoningRunes", reasoning,
		"titleRunes", len([]rune(in)))
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
