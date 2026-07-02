package jobs

import "context"

// PollAllFeedsForTest exposes the unexported pollAllFeeds for tests.
func (r *Runner) PollAllFeedsForTest(ctx context.Context) { r.pollAllFeeds(ctx) }
