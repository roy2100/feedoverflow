# Plan: Remove Host Migration Script

## Goal

Remove the one-time host deployment migration script so deployment no longer includes an automated file-moving workflow.

## Scope

- Delete `scripts/migrate-host-deployment.sh`
- Remove its reference and instructions from `scripts/README.md`
- Remove the plan document that only described the deleted script
- Keep the renamed deployment scripts and install/deploy lifecycle unchanged

## Steps

1. Delete the one-time migration script and its dedicated historical plan.
2. Remove the migration-script entry and usage section from the scripts README.
3. Review references and the resulting diff.
4. Append the outcome to this plan.

## Risks & Open Questions

- Users who need to retain an old deployment database must now move it manually.

## Estimated Complexity

Low — this removes an isolated script and its documentation.

## Outcome

Removed `scripts/migrate-host-deployment.sh`, its dedicated plan, and all user-facing migration instructions from `scripts/README.md`. The renamed deployment scripts and their installation/deployment lifecycle remain unchanged.
