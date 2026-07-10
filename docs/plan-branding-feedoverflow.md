# Plan: FeedOverflow Branding Update

## Goal

Rename the user-visible product identity from RSS Reader to FeedOverflow in the web UI, PWA metadata, MCP implementation metadata, and Docker image configuration without changing deployment paths, package/module names, or service identifiers.

## Scope

- Update visible browser, PWA, and login labels
- Update the MCP server implementation name and local MCP configuration key
- Rename the Docker Compose image tag and container binary artifact
- Keep deployment paths, launchd labels, Go module paths, and historical documentation unchanged

## Steps

1. Inspect the targeted branding and container configuration files to confirm their current values.
2. Replace visible UI and PWA labels with FeedOverflow.
3. Replace MCP implementation and local configuration identifiers with `feedoverflow`.
4. Rename the Docker image tag and binary artifact to `feedoverflow`.
5. Review the diff and append the implemented outcome to this plan.

## Risks & Open Questions

- Changing the local MCP configuration key requires users of the old `rss-reader` key to update their client configuration.
- Renaming the Docker binary changes the image's entrypoint only; it does not affect host deployment scripts, which are explicitly out of scope.

## Estimated Complexity

Medium — the change is limited in scope but touches configuration consumed by browsers, MCP clients, and container tooling.

## Outcome

Updated the browser title, Apple web-app title, PWA manifest name and short name, and login label to FeedOverflow. Renamed the local MCP configuration key and server implementation name to `feedoverflow`. Renamed the Docker image tag and container binary/entrypoint to `feedoverflow`. Package/module identifiers and host deployment paths were deliberately left unchanged. The client production build and complete Go test suite passed.
