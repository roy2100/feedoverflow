# Plan: Add PWA and Favicon Assets

## Goal
Use the supplied RSS artwork as the application favicon and PWA icon source so browser tabs, installed app shortcuts, and Apple touch icons use a consistent identity.

## Scope
- Add the supplied artwork to the client public assets.
- Generate the required favicon and PWA icon sizes.
- Update the HTML and web manifest references.
- Crop regular PWA icons to eliminate wasted outer canvas and add a dedicated maskable icon.
- Verify that referenced assets exist and client checks remain valid.

## Steps
1. Inspect the client’s current static asset, manifest, and HTML configuration.
2. Copy the supplied source artwork into the project and generate favicon/PWA icon variants.
3. Update the manifest and HTML head to reference the new assets.
4. Run focused validation for asset references and client formatting/lint checks as appropriate.

## Risks & Open Questions
- The supplied artwork has a white outer margin; retaining it preserves the provided design but can make the icon appear slightly smaller in browser chrome.
- Existing PWA configuration may use nonstandard asset names and will be preserved unless replacement is necessary.

## Estimated Complexity
Medium — requires binary asset generation plus coordinated manifest and HTML updates.

## Outcome
Generated 32px favicon, 180px Apple touch icon, and 192px/512px PWA icons directly from the supplied RSS artwork. Updated the HTML head to prefer the new PNG favicon rather than the previous SVG; the existing Vite PWA manifest already references the regenerated PWA icons.

The source artwork was subsequently replaced with a version that visually showed a transparency checkerboard. Its PNG data did not contain an alpha channel, so the checkerboard was removed with a deterministic rounded-rectangle alpha mask before regenerating the icon assets.

The PWA assets were then refined to remove excess outer padding and provide a dedicated maskable icon.
