import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildDate = `v${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'FeedOverflow',
        short_name: 'FeedOverflow',
        description: '个人 RSS 阅读器',
        theme_color: '#2B5C5C',
        background_color: '#F5F2EE',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'any',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 缓存应用 shell（JS/CSS/HTML）
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Web Push 的 push/notificationclick 监听器（public/push-sw.js）。用
        // importScripts 挂进生成的 SW，避免为两个监听器改用 injectManifest 而要自己
        // 维护预缓存清单。
        importScripts: ['push-sw.js'],
        runtimeCaching: [
          {
            // Article feeds: show cached content immediately, refresh in background.
            // Workbox matches against the full URL, so these patterns must NOT be
            // anchored with ^ — a same-origin request is https://host/api/today.
            urlPattern: /\/api\/(today|all-articles|starred)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-articles',
              expiration: {
                maxEntries: 5,
                maxAgeSeconds: 60 * 5,
              },
              cacheableResponse: {
                statuses: [200],
              },
            },
          },
          {
            // Auth endpoints: never cached, never served from cache. A stale
            // auth-check would keep showing the app as logged in after a logout.
            // Must be registered before the catch-all /api/ rule below — Workbox
            // takes the first matching route.
            urlPattern: /\/api\/(login|logout|auth-check)$/,
            handler: 'NetworkOnly',
          },
          {
            // Other API requests: network first, fall back to cache
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Google Fonts stylesheet: revalidate in the background so the @font-face
            // rules can never drift out of sync with what is actually in the font cache.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Google Fonts files. Google slices Noto Serif SC into ~100 unicode-range
            // subsets per weight, so the entry cap has to be in the hundreds — at a
            // handful, LRU eviction thrashes and CJK text refetches on every article.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 400,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/types.ts',
      ],
    },
  },
});
