package translate

import "unicode"

// chineseRatio is the share of letter runes that must be Han for a title to count
// as already Chinese. Well below half on purpose: a Chinese headline routinely
// carries a Latin product name ("苹果发布 M5 芯片"), and a wrong skip only costs a
// missing translation, while a wrong send costs an API call on every such title.
const chineseRatio = 0.3

// IsMostlyChinese reports whether a title needs no translation. Running this
// before every request is what keeps a Chinese feed with the switch accidentally
// on from costing anything at all.
func IsMostlyChinese(s string) bool {
	var letters, han int
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
			letters++
		case unicode.IsLetter(r):
			letters++
		}
	}
	if letters == 0 {
		// Digits, punctuation, emoji — nothing a translation would change.
		return true
	}
	return float64(han)/float64(letters) >= chineseRatio
}
