import ReactDOM from 'react-dom/client';

import App from './App';
import DemoBanner, { DEMO_MODE, DEMO_BANNER_HEIGHT } from './components/DemoBanner';

import './index.css';

// The demo build stacks a fixed-height banner above <App/> inside #root. The app
// reads its height from --app-height, so the app gets (viewport − banner) while
// the page body (html/body/#root are height:var(--app-height) in CSS) is pinned
// back to the full viewport — otherwise shrinking --app-height would shrink the
// body itself and leave a gap below. 0 offset in production → identical to before.
const bannerOffset = DEMO_MODE ? DEMO_BANNER_HEIGHT : 0;
const rootEl = document.getElementById('root')!;

// iOS standalone-PWA viewport fix. After following an external link and
// returning, Safari hands back a stale (too-tall) `100dvh`/`100vh`, leaving a
// blank strip at the bottom. Drive the layout height from window.innerHeight
// instead and re-measure on every event that fires on return.
function syncAppHeight() {
  const h = window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${h - bannerOffset}px`);
  if (DEMO_MODE) {
    // Keep the page body full-height so banner + app exactly fill the viewport.
    for (const el of [document.documentElement, document.body, rootEl]) {
      el.style.height = `${h}px`;
    }
  }
}
syncAppHeight();
for (const ev of ['resize', 'orientationchange', 'pageshow'] as const) {
  window.addEventListener(ev, syncAppHeight);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncAppHeight();
});

ReactDOM.createRoot(rootEl).render(
  <>
    <DemoBanner />
    <App />
  </>,
);
