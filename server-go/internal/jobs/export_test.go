package jobs

import "context"

// PollAllFeedsForTest exposes the unexported pollAllFeeds for tests.
func (r *Runner) PollAllFeedsForTest(ctx context.Context) { r.pollAllFeeds(ctx) }

// TranslatePendingForTest exposes one translator tick for tests.
func (r *Runner) TranslatePendingForTest(ctx context.Context) { r.translatePending(ctx) }

// TranslateWindowForTest is the pending-window width, so tests can place rows on
// either side of it without duplicating the constant.
const TranslateWindowForTest = translateWindow
