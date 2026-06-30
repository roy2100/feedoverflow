import ReactDOM from 'react-dom/client';

import App from './App';

import './index.css';

// iOS standalone-PWA viewport fix. After following an external link and
// returning, Safari hands back a stale (too-tall) `100dvh`/`100vh`, leaving a
// blank strip at the bottom. Drive the layout height from window.innerHeight
// instead and re-measure on every event that fires on return.
function syncAppHeight() {
  document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
}
syncAppHeight();
for (const ev of ['resize', 'orientationchange', 'pageshow'] as const) {
  window.addEventListener(ev, syncAppHeight);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncAppHeight();
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
