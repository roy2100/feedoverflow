// Web Push handlers, pulled into the generated service worker via
// workbox.importScripts in vite.config.js. It lives here rather than in a
// hand-written sw.ts so the existing generateSW/precaching setup stays untouched
// — switching the plugin to injectManifest would mean owning the precache
// manifest wiring for the sake of these two listeners.
//
// The payload shape is produced by server-go/internal/push (payload struct):
//   { title, body, url, tag }
// Keep the two in sync. `url` for a per-article notification is an in-app deep
// link, `/?article=<id>` — see notificationclick below for how it is delivered.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON (or empty) payload still deserves to surface —
    // silently dropping it looks identical to a broken subscription.
  }
  const title = data.title || 'FeedOverflow';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      // Same tag replaces an earlier notification instead of stacking; the server
      // gives per-article notifications unique tags and reuses one tag per feed
      // for the collapsed "N 篇新文章" summary.
      tag: data.tag || 'feedoverflow',
      data: { url: data.url || '/' },
    }),
  );
});

// Pull the article id back out of the `/?article=<id>` deep link. The id is the
// only part the running app needs; the URL form exists for the cold-start case.
function articleIdOf(url) {
  const match = /[?&]article=([^&]+)/.exec(url || '');
  return match ? decodeURIComponent(match[1]) : null;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      // Reuse an already-open app window when there is one — on iOS especially,
      // opening a second window instead of focusing the installed PWA is jarring.
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          await client.focus();
          // postMessage rather than client.navigate: navigating reloads the app,
          // which would tear down any podcast playing and lose scroll position.
          // The app opens the article in place (see App.tsx). client.navigate is
          // also unimplemented in some iOS versions.
          const id = articleIdOf(target);
          if (id) client.postMessage({ type: 'open-article', id });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
