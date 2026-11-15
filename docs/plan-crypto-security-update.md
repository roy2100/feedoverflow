# Plan: update x/crypto for the dependency audit

## Goal

Resolve GO-2026-5932 by upgrading the Go backend's golang.org/x/crypto from v0.58.0 to v0.59.0, and rebuild with Go 1.27.4 to resolve standard-library advisory GO-2026-6859.

## Scope

In: server-go/go.mod and go.sum, required backend checks and root lint/format checks, source vulnerability scan, and the normal deploy script.

Out: application behavior changes, database/configuration changes, advisory acknowledgements, frontend dependency changes, and unrelated module upgrades.

## Steps

1. Upgrade x/crypto to v0.59.0 and review the module/checksum diff.
2. Run server-go make check, root npm run fmt:check and npm run lint, and govulncheck under Go 1.27.4.
3. Record the verification results and commit the module update.
4. Preserve the installed executable, frontend assets, and service definition. Run scripts/deploy.sh, verify the existing health endpoint, and check the installed Go version.

## Risks / open questions

- The deploy script replaces assets and builds into the deployed executable path, so a recovery snapshot is required before it starts.
- Preserve all production database/configuration files and secrets.

## Complexity

Low. A module update, existing checks, and standard deployment verification.

## Outcome

On 2026-11-15, upgraded x/crypto to v0.59.0 and ran go mod tidy. Its required module graph also raises x/sys to v0.50.0 and x/text to v0.44.0. No application code or frontend dependencies changed.

With Go 1.27.4, backend make check (including staticcheck and offline tests), root npm run fmt:check, and npm run lint all passed. govulncheck -json ./... returned no findings.

The standard deploy script completed successfully, the existing health check passed, and the installed executable reports Go 1.27.4 with the fixed module versions. No production database or configuration files were changed by the deployment.
