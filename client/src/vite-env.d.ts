/// <reference types="vite/client" />

// Injected by `vite.config.ts` via `define`.
declare const __BUILD_DATE__: string;

interface ImportMetaEnv {
  // Set to "1" for the public demo build to show the demo banner (see DemoBanner.tsx).
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
