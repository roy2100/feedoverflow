import ReactDOM from 'react-dom/client';

import App from './App';
import DemoBanner, { DEMO_MODE, DEMO_BANNER_HEIGHT } from './components/DemoBanner';

import './index.css';

// The demo build reserves a fixed strip at the top for the banner; every layout
// height is driven off --app-height, so shrinking it here keeps the banner from
// overlapping the app. 0 in the production build → identical to before.
const bannerOffset = DEMO_MODE ? DEMO_BANNER_HEIGHT : 0;

// iOS standalone-PWA viewport fix. After following an external link and
// returning, Safari hands back a stale (too-tall) `100dvh`/`100vh`, leaving a
// blank strip at the bottom. Drive the layout height from window.innerHeight
// instead and re-measure on every event that fires on return.
function syncAppHeight() {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.innerHeight - bannerOffset}px`,
  );
}
syncAppHeight();
for (const ev of ['resize', 'orientationchange', 'pageshow'] as const) {
  window.addEventListener(ev, syncAppHeight);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncAppHeight();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <DemoBanner />
    <App />
  </>,
);
