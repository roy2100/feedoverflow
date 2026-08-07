// Package translate turns an article title into Chinese via an OpenAI-compatible
// chat-completions endpoint.
//
// There is deliberately no provider abstraction. `POST {base_url}/chat/completions`
// with a bearer token is answered by DeepSeek, OpenAI, Moonshot, 智谱, SiliconFlow,
// OpenRouter, Ollama and vLLM alike, so the provider is a config value (see the
// llm_config table) rather than something this code knows about.
//
// One title per request, never a batch. Batching would save tokens — on the order
// of ¥0.02/day at this app's volume — and buy the one failure that must never
// happen: a model that drops or merges an element in a batched response shifts
// every following translation onto the wrong article, silently and permanently.
// With one title per request that misalignment is structurally impossible, which
// also removes the index-keyed wire protocol, the tolerant JSON decoder and the
// partial-failure semantics a batch would need.
//
// Batching one feed's titles together was reconsidered as a way to give the model
// context, and rejected again: what a headline needs is its *own* article, not its
// siblings, and that fits in a per-row Request with the failure mode above still
// impossible. See docs/plan-translation-context.md.
package translate

import (
	"context"
	"errors"
)

// Config is the resolved llm_config row.
type Config struct {
	BaseURL string
	APIKey  string
	Model   string
}

// Ready reports whether translation is switched on. An empty key is how the
// feature is disabled — there is no separate toggle.
func (c Config) Ready() bool {
	return c.APIKey != "" && c.BaseURL != "" && c.Model != ""
}

// Request is one title plus the context that disambiguates it.
//
// FeedName and Summary are optional and exist for one reason: a headline is terse
// by construction, and most bad translations are the model not knowing what the
// article is about ("Rust drops…", a pun that only resolves once you know the
// subject). The article's own summary answers that; sibling headlines from the
// same feed, the other candidate, do not.
//
// Both are attacker-controlled feed text and both travel in the user message —
// that separation, not their length, is what keeps them out of the instruction
// channel. See userMessage.
type Request struct {
	Title    string
	FeedName string
	Summary  string
}

// Translator is the seam the jobs worker depends on, so its tests run offline
// against a fake and never touch the network.
type Translator interface {
	// Translate returns the Chinese rendering of req.Title. An empty string (with a
	// nil error) means the endpoint answered but gave nothing usable — the caller
	// settles the row rather than retrying. A non-nil error means the request
	// itself failed and is worth retrying.
	Translate(ctx context.Context, cfg Config, req Request) (string, error)
}

// Checker is the seam POST /api/llm/config/test depends on. It is separate from
// Translator only so the handler cannot accidentally be handed something that
// translates but was never meant to be called synchronously from a request.
type Checker interface {
	Check(ctx context.Context, cfg Config) error
}

// Normalized failures, so the settings UI can say something specific without the
// handler ever echoing an upstream response body back to the browser.
var (
	ErrAuth     = errors.New("认证失败：API Key 无效或已过期")
	ErrModel    = errors.New("模型不可用：请检查模型名称")
	ErrConnect  = errors.New("无法连接：请检查 API 地址")
	ErrUpstream = errors.New("服务返回错误")
)
