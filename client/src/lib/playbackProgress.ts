// Per-episode playback position, so closing the player (or the app) mid-episode
// and coming back later resumes where you stopped instead of restarting.
//
// The durable copy lives in SQLite (`article_states.play_position`, behind
// /api/podcast-progress), not in localStorage: a resume then survives a
// browser-data wipe and follows the listener across devices — start an episode on
// the Mac, pick it up on the phone. Rationale and the server side:
// docs/plan-podcast-progress-sqlite.md.
//
// A network round-trip can't sit in the middle of `handlePlay`, though: the resume
// seek runs in the same task as `audio.play()`, and awaiting there would cost the
// user-gesture attribution Safari's autoplay policy requires. So this module keeps
// an in-memory map — filled once by `hydrate()` at startup, written through on
// every save — and `loadProgress` stays synchronous against it.
const API = '/api/podcast-progress';

// Under this, resuming is indistinguishable from starting over — and if playback
// really did stop a few seconds in, jumping back to 0 is what you'd want anyway.
const MIN_RESUME_SECONDS = 15;

// Within this of the end the episode counts as finished. Checked here rather than
// on the server, which has no idea how long the audio actually is: the element's
// live `duration` is the only reliable source, so the client decides and sends a
// clear instead of a save.
const END_MARGIN_SECONDS = 20;

/** id → position in seconds. Empty until hydrate() lands. */
const positions = new Map<string, number>();

/**
 * Fires a write at the server. Progress is a nicety, never a reason to surface an
 * error, so failures are swallowed.
 *
 * `sendBeacon` is preferred because the save that matters most is the one from
 * `visibilitychange: hidden` — an iOS PWA being backgrounded and then killed,
 * which is the whole reason the periodic save exists. A plain fetch from that
 * handler can be dropped when the page freezes; a beacon is queued by the browser
 * and survives. Both carry same-origin cookies, so the auth gate is satisfied
 * either way.
 */
function send(url: string, method: 'POST' | 'DELETE', body?: unknown) {
  const payload = body === undefined ? null : JSON.stringify(body);
  if (method === 'POST' && payload && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))) return;
    } catch {
      /* beacon queue full or unavailable — fall through to fetch */
    }
  }
  try {
    void fetch(url, {
      method,
      keepalive: true,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ?? undefined,
    }).catch(() => {});
  } catch {
    /* offline */
  }
}

/**
 * Loads the recent positions into memory. Called once at startup, next to the
 * store's init(). An episode started before this lands starts from the top — one
 * request's worth of window, against a list the user has to wait for anyway.
 */
export async function hydrate(): Promise<void> {
  try {
    const r = await fetch(API);
    if (!r.ok) return;
    const { progress } = (await r.json()) as { progress?: Record<string, number> };
    for (const [id, seconds] of Object.entries(progress ?? {})) {
      if (typeof seconds === 'number' && Number.isFinite(seconds)) positions.set(id, seconds);
    }
  } catch {
    // No positions is the same as never having listened: resume just doesn't happen.
  }
}

export function saveProgress(id: string, position: number, duration: number) {
  if (!id || !Number.isFinite(position) || position <= 0) return;
  // Ran to the end: forget it, so playing it again starts at the top. Storing the
  // position and filtering it on read would work too, but then the DB carries rows
  // that can never produce a resume. Guarded on the map so the periodic save
  // doesn't re-send the same delete every 5s through the closing credits — the
  // `ended` handler's own clearProgress is the unguarded one.
  if (Number.isFinite(duration) && duration > 0 && position > duration - END_MARGIN_SECONDS) {
    if (positions.has(id)) clearProgress(id);
    return;
  }
  const seconds = Math.round(position);
  positions.set(id, seconds);
  send(API, 'POST', { id, position: seconds, duration: Number.isFinite(duration) ? duration : 0 });
}

// Where this episode should start. 0 means "from the top" — no entry, or barely
// started.
export function loadProgress(id: string): number {
  const seconds = positions.get(id);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < MIN_RESUME_SECONDS) return 0;
  return seconds;
}

export function clearProgress(id: string) {
  if (!id) return;
  // Unconditional: the in-memory map only holds what this session hydrated or
  // wrote, so "not in the map" is no evidence the server has nothing.
  positions.delete(id);
  send(`${API}/${encodeURIComponent(id)}`, 'DELETE');
}

/** Test seam — drops the in-memory map so each case starts from a cold app. */
export function __resetProgressCache() {
  positions.clear();
}
