// Build-time demo marker. Rendered only when the client is built with
// VITE_DEMO_MODE=1 (the public demo instance); a no-op in the production build,
// so this file is dormant on `main`. It's a normal-flow strip that stacks above
// <App/> inside #root (main.tsx keeps the page body at full viewport height and
// gives the app the remaining --app-height), so it reserves space rather than
// overlapping the app chrome.
export const DEMO_MODE = Boolean(import.meta.env.VITE_DEMO_MODE);
export const DEMO_BANNER_HEIGHT = 32;

export default function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div
      role="note"
      style={{
        height: DEMO_BANNER_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.5em',
        padding: '0 12px',
        fontSize: 13,
        fontWeight: 600,
        color: '#fff',
        background: 'linear-gradient(90deg, #b45309, #d97706)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
        textAlign: 'center',
        userSelect: 'none',
        position: 'relative',
        zIndex: 2000,
      }}
    >
      <span>Live demo — sample data, resets every 6&nbsp;hours.</span>
    </div>
  );
}
