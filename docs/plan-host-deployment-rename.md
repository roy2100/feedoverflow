# Plan: Host Deployment Rename

## Goal

Rename the host deployment identity from `rss-reader` to `feedoverflow` in the deployment scripts and their local documentation, since no existing deployment needs compatibility or migration support.

## Scope

- Update deployment directories, binary names, and launchd labels used by `scripts/`
- Update shell comments and the scripts README to match the new identifiers
- Keep Docker configuration, package/module names, and historical documentation out of scope

## Steps

1. Locate every `rss-reader` deployment identifier used by files under `scripts/`.
2. Replace the deployment root, binary name, and launchd service label with FeedOverflow equivalents.
3. Update operational documentation in `scripts/README.md` to reflect the renamed deployment.
4. Run shell syntax checks and review the resulting diff.
5. Append the completed outcome to this plan.

## Risks & Open Questions

- Existing host installations would stop working after this change, but the user confirmed none need to be preserved.
- Service installation must be run again after the change to create the renamed launchd job.

## Estimated Complexity

Medium — several scripts share deployment identifiers and must remain mutually consistent.

## Outcome

Renamed the deployment root to `~/Deploy/feedoverflow`, the launchd label to `com.feedoverflow.app`, and the deployed binary to `feedoverflow`. Updated every matching script reference and `scripts/README.md`. Shell syntax validation passed for all deployment scripts. No migration or backward-compatibility support was added, as requested.
