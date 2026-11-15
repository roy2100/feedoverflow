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
