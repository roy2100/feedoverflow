// Per-episode playback position, so closing the player (or the app) mid-episode
// and coming back later resumes where you stopped instead of restarting.
//
// localStorage, keyed by article id: the position is per-device listening state,
// not shared reader data, and a resume that survives a reload is worth exactly
// nothing to the other clients that would see it in the DB.
const KEY = 'podcast-progress';

// Enough for months of listening; pruned oldest-first so the store can't grow
// without bound as feeds churn.
const MAX_ENTRIES = 200;

// Under this, resuming is indistinguishable from starting over — and if playback
// really did stop a few seconds in, jumping back to 0 is what you'd want anyway.
const MIN_RESUME_SECONDS = 15;

// Within this of the end the episode counts as finished: replay starts at 0.
const END_MARGIN_SECONDS = 20;

interface Entry {
  /** Position in seconds. */
  t: number;
  /** Duration in seconds, 0 when the source never reported one. */
  d: number;
  /** Last write, epoch ms — the pruning key. */
  at: number;
}

type Store = Record<string, Entry>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    // Unparseable or unavailable (private mode, quota) — resume is a nicety,
    // never a reason to break playback.
    return {};
  }
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable or full */
  }
}

function prune(store: Store): Store {
  const ids = Object.keys(store);
  if (ids.length <= MAX_ENTRIES) return store;
  const keep = ids.sort((a, b) => (store[b]?.at ?? 0) - (store[a]?.at ?? 0)).slice(0, MAX_ENTRIES);
  return Object.fromEntries(keep.map((id) => [id, store[id]]));
}

export function saveProgress(id: string, position: number, duration: number) {
  if (!id || !Number.isFinite(position) || position <= 0) return;
  const store = read();
  store[id] = {
    t: position,
    d: Number.isFinite(duration) && duration > 0 ? duration : 0,
    at: Date.now(),
  };
  write(prune(store));
}

// Where this episode should start. 0 means "from the top" — no entry, barely
// started, or listened to the end.
export function loadProgress(id: string): number {
  const entry = read()[id];
  if (!entry || !Number.isFinite(entry.t) || entry.t < MIN_RESUME_SECONDS) return 0;
  if (entry.d > 0 && entry.t > entry.d - END_MARGIN_SECONDS) return 0;
  return entry.t;
}

export function clearProgress(id: string) {
  const store = read();
  if (!(id in store)) return;
  delete store[id];
  write(store);
}
