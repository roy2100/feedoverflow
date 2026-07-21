// Web Push handlers, pulled into the generated service worker via
// workbox.importScripts in vite.config.js. It lives here rather than in a
// hand-written sw.ts so the existing generateSW/precaching setup stays untouched
// — switching the plugin to injectManifest would mean owning the precache
// manifest wiring for the sake of these two listeners.
//
// The payload shape is produced by server-go/internal/push (payload struct):
//   { title, body, url, tag }
// Keep the two in sync.

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
          if (target !== '/' && 'navigate' in client) {
            try {
              await client.navigate(target);
            } catch {
              // Cross-origin article links can't be navigated to from here; the
              // focused app is a reasonable landing spot on its own.
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
