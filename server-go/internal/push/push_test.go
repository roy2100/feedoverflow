package push

import "testing"

// A configured `mailto:` subject must reach webpush-go as a bare address: the
// library prefixes "mailto:" onto anything that is not an https URL, and the
// resulting "mailto:mailto:…" `sub` claim makes Apple reject every push with
// 403 BadJwtToken — silently, since the send itself succeeds at the HTTP level.
func TestVapidSubscriber(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"mailto:you@example.com", "you@example.com"},
		{"you@example.com", "you@example.com"},
		{"https://rss.example.com", "https://rss.example.com"},
	} {
		if got := vapidSubscriber(tc.in); got != tc.want {
			t.Errorf("vapidSubscriber(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
