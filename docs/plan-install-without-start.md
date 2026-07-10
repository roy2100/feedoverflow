# Plan: Install Service Without Starting

## Goal

Make `scripts/install-service.sh` create the FeedOverflow LaunchAgent plist without starting the service, and move service startup to `scripts/deploy.sh`.

## Scope

- Change the install script to write only the plist
- Change deployment to bootstrap and start the installed service
- Update the scripts README and script comments to describe the new order
- Preserve the existing service configuration and health-check behavior after deployment

## Steps

1. Inspect the installation, deployment, and shared launchd helper behavior.
2. Remove startup and binary-existence requirements from the install script.
3. Have deployment reload/bootstrap the installed plist before the health check.
4. Update the documented first-deployment sequence and comments.
5. Validate shell syntax and append the outcome to this plan.

## Risks & Open Questions

- The first-deployment order changes to install the plist first, then deploy the binary and start the service.
- Running `install-service.sh` alone leaves a plist on disk but no active launchd job, which is intentional.

## Estimated Complexity

Medium — the two scripts share lifecycle responsibilities and must retain a valid bootstrap/start sequence.

## Outcome

`install-service.sh` now writes only the LaunchAgent plist and does not require an existing binary, bootstrap launchd, start the service, or run a health check. `deploy.sh` now reloads the installed plist after building, which bootstraps and starts the service before its existing health check. The first-deployment order and migration-script output were updated to install first, then deploy. All shell scripts passed syntax validation, and an isolated install-script test confirmed that it writes the plist without starting a service.
