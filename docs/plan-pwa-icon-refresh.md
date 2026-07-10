# Plan: Refresh PWA Icon Artwork

## Goal
Regenerate the FeedOverflow PWA icon assets from the newly supplied logo artwork while retaining correct standard and maskable icon behavior.

## Scope
- Replace the standard 192px and 512px PWA icons.
- Replace the dedicated 512px maskable PWA icon.
- Verify image dimensions, alpha handling, manifest references, and production build output.

## Steps
1. Inspect the supplied artwork dimensions and alpha-channel metadata.
2. Crop and scale the artwork for the standard PWA icon sizes.
3. Generate a full-bleed maskable variant and retain the existing manifest mapping.
4. Validate generated images and build the client.

## Risks & Open Questions
- Visual transparency checkers can be embedded pixels rather than an alpha channel; generated files must be verified for actual alpha data.
- The maskable icon requires an opaque edge-to-edge background to avoid appearing undersized in Android launchers.

## Estimated Complexity
Medium — coordinated binary asset generation and PWA validation across three icon variants.

## Outcome
Regenerated `pwa-192x192.png`, `pwa-512x512.png`, and `pwa-maskable-512x512.png` from the supplied artwork. Converted its visual checkerboard border into actual transparent rounded corners for standard icons, and composited the same artwork onto an opaque orange background for the maskable variant.
