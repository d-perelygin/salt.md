# ADR 001: deploy/server is the rollup branch for server deploys

Status: accepted

## Context

Features land in short-lived `up/*` and `feat/*` branches. The production
server (docs/tasks instances) runs from the owner's fork
`d-perelygin/salt.md`, not from upstream, and the deploy pipeline builds a
single branch.

## Decision

`deploy/server` on the fork is the branch where everything meant for the
server gets merged: it is the only source the deploy pipeline builds from.
Rules:

- Every server-bound change (features, fixes, migrations) is merged or
  cherry-picked into `deploy/server` and pushed to `origin` (the fork).
- `upstream` is never pushed to and never deployed from.
- Screenshot-only retakes (`wiki/img`, `screenshots.json` churn) stay out of
  this branch; screenshots are retaken honestly at build time during deploy.
- Merge adaptations between rolled-up branches are fixed directly on
  `deploy/server` (e.g. adapting callers to a changed server API).

## Consequences

One branch to build, one branch to back up against. Feature branches stay
small and reviewable; integration risk is concentrated in `deploy/server`,
which is verified (`go test ./...`, frontend check gate) before deploy.
