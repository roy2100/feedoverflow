# Plan: Release relative feed article times

## Goal

Commit, push, and deploy the relative publication-time display in feed management.

## Scope

In scope:
- Release the implemented `今天`, `昨天`, and `N 天前` display, preserving full timestamp tooltips and future-date labels.
- Include the implementation notes in the tracked documentation.
- Push `main` to `origin` and deploy with the existing macOS deployment script.
- Verify local health, public availability, and the deployed client assets.

Out of scope:
- Database changes, feed polling changes, or new UI behavior.
- Browser automation or screenshots.

## Steps

1. Review the pending relative-date change and the deployment scripts.
2. Record the implementation outcome and run the formatting/lint gates before committing.
3. Commit the code and documentation using Conventional Commits and push `main` to `origin`.
4. Run `scripts/deploy.sh` to build and sync the client, build the backend, and restart launchd.
5. Verify health and deployed assets, then append the release outcome and commit/push that record.

## Risks and Open Questions

- The deploy briefly restarts the running service. The existing script checks loopback health after restart.
- `npm install` in the deployment script can modify dependency metadata; inspect the working tree afterward and report any unexpected changes.
- Public reachability depends on the existing tunnel. A public failure must be distinguished from the local app health result.
- Relative dates use local calendar dates rather than elapsed 24-hour periods, including across daylight-saving transitions.

## Complexity

Low: one UI file, documentation, and the existing deployment workflow.

## Outcome

- Committed the relative publication-date display as `0ce076d` and pushed `main` to `origin`, including the preceding management-list changes.
- Formatting, lint, and diff checks passed before commit. The change had also passed all 25 feed-panel/style-scale tests and client TypeScript checks.
- Automatic approval initially blocked production deployment pending explicit confirmation of `~/Deploy/feedoverflow` and `com.feedoverflow.app`. The user confirmed both targets, and the existing deployment script then completed successfully.
- Production client build, Go binary build, launchd restart, and loopback `/healthz` verification passed. The app is running, and the reverse-tunnel launchd process is also running.
- The generated management bundle, deployed file, and bundle served by the local public listener have identical SHA-256 hashes: `f36571b2d7625a404faed939a62386b6aad225f84eceafb065a3aa8bd036a45e`.
- Public HTTPS verification could not complete: both ordinary and direct IPv4 requests failed during TLS negotiation with `SSL_ERROR_SYSCALL`. Deployment is locally verified; public reachability remains unverified. No tunnel or TLS configuration was changed.
- Deployment did not modify tracked dependency files. `npm install` reported 16 dependency vulnerabilities (3 low, 7 moderate, 6 high); no dependency upgrades were attempted in this release.
- No browser automation or screenshots were used.
