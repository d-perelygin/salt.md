# Feature flow

Default: **one tree, one feature branch at a time**. A separate worktree is created
only for large features — the agent decides (long-lived, parallel active work, or
a big refactor that would churn the tree). Small fixes stay in the main checkout.

## Per feature

1. **Sync**: `git fetch upstream`; branch from fresh `upstream/main`: `feat/<name>`.
2. **Issue** in the fork (`gh issue create`); triage labels (`needs-triage` → `ready-for-agent`
   when specified). Link the issue to the session via `session.link`.
3. **Spec**: upstream candidates get `to-spec` (+ `grill-me` for big ones — upstream has
   opinions: one binary, no external services, English source, derived-from-code).
   Fork-only features get a shorter spec or go straight to tickets.
4. **Tickets**: `to-tickets` with blocking edges; epics go through `wayfinder`.
5. **Implement** per ticket. Verify by touch: backend → `go test ./...`,
   web/ → `cd web && npm run check`.
6. **Upstream gate** (below) decides where it lands.
7. **Finish**: clean history, PR. `AGENTS.md` and `docs/agents/*` never go into upstream PRs.

## Worktree (large features only)

- Location: sibling dir (`../salt-md-<feat>`), never `/tmp`. New worktree sessions
  become the session's directory via `session_move`.
- Separate server instance per worktree: own port (`8420+N`) and own `SALT_DATA`
  — two servers must not share `:8420` or one SQLite file.
- Delete the worktree when the feature merges.

## Upstream gate — propose per feature

- **To upstream**: general-purpose, fits project opinions, small focused diff.
  Big changes need an upstream issue first (per CONTRIBUTING); PRs need a signed CLA.
- **Fork-only**: personal customization, opinion-violating, large/sprawling, or
  clearly unmergeable. Mark the branch; don't reshape it to foreign requirements.
