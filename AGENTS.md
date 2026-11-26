# AGENTS.md

## Build / run
- `make build` (frontend + backend), `./salt` → `:8420`
- Dev: `SALT_DATA=/tmp/salt-dev SALT_ADDR=:8420 go run .` + `cd web && npx vite`
- Go 1.25, Node 20; `CGO_ENABLED=0`, `-trimpath`; one binary embeds `web/dist`

## Verify (CI: `.github/workflows/ci.yml`)
- `go test ./...`
- `cd web && npm run check` (tsc + `check-*.mjs`; runs inside `npm run build`, unskippable)
- Source + comments in English only; source text is the translation key

### Test gates (what to run when)

- **Batch, don't gate every edit.** This is a standing preference, not a suggestion:
  collect related edits, build once per batch, test only what the change touches, and
  run the full gate once at the end of the batch — before the commit or push. Repeating
  `vite build` / `go test ./...` / `npm run check` after each small step makes the loop
  painfully slow and is explicitly not wanted.
- **While editing**: `go test ./...` when the change is Go (cached unless `web/dist`
  changed), `cd web && npx tsc --noEmit`, and only the browser tests the change touches:
  `cd web/tests && node run.mjs mobile-shell board-edge-scroll`.
- **Before a push**: `cd web && npm run check` (~25s), `go test ./...`, then the whole
  browser suite: `cd web/tests && npm test` — parallel, four workers, about three and a
  half minutes instead of ~12 serially. Ten tests are currently red against merged
  upstream UI and are listed at the end of a run; run the files around your change by
  name until they are repaired. Security or concurrency changes also get
  `go test -race -run TestSecurity_ ./server/...`.
- Screenshots: `npm run check` names the stale ones; retake exactly those ids with
  `node scripts/shoot-wiki.mjs <id> …`.
- The browser suite is not in CI; it is the local pre-push gate. CI runs `make frontend`
  (the check chain + Vite build) and `go test ./...`.
- `npx vite build` rewrites hashed assets, so the embedded-dist hash changes and Go's
  test cache misses: `salt/server` re-runs (about a minute). Run the Go tests before a
  build when both are due in one cycle.
- `node run.mjs --serial` restores the one-at-a-time order when a failure needs a clean,
  uncluttered log.

## Architecture
- Single `server/` Go package, entry `server.New()` in `server/server.go`
- SQLite `salt.db` + `files/`; no external services
- `wiki/*.md` build-checked vs MCP catalogue + routes (`check-wiki.mjs`)

## Contributing
- Big change → open issue first; PR needs signed CLA; security → `dev@salt.md`; AGPL-3.0

## Agent environment notes (local dev loop)

- Ports are shared with sibling sessions: `:8420`/`:8421` are often taken by
  someone else's `go run .`. Check `lsof -i :PORT` first; never kill чужое —
  take a free one (`:8425`+). `pkill -f 'tmp/salt'` misses `go run` builds.
- In-app browser (OpenChamber panel) works but hangs intermittently (20s
  timeouts, `UnknownVizError`, expiring tab ids). Retry once; if still dead,
  fall back to lightpanda `evaluate` for DOM reads and real-Chromium checks
  via `playwright` (`npm i --no-save playwright`, browsers in
  `~/Library/Caches/ms-playwright`).
- lightpanda's JS context has no `EventSource`: the SPA crashes there, so it
  fits API/DOM reads on public pages, never logged-in flows. Its `hover`
  does not reach the page — verify hovers with playwright `mouse` instead.
- Touch emulation has a floor. Playwright/CDP dispatches a clean `pointerup`
  every time and will not synthesize a second pointer for a touch added
  mid-sequence, so "the gesture's end never arrived" bugs — and anything that
  only shows on a real phone — cannot be reproduced there. Trust the device
  report for those and use emulation only to prove the ordinary path still
  works. `preventDefault()` on `pointerdown` is the usual suspect: the table's
  column resize deliberately never cancels it.
- A sibling session shares this working tree: `git status` regularly shows
  their uncommitted files, and an `npm ci`/`npm install` under `web/` wipes
  `node_modules/playwright` mid-run (reinstall before a Playwright run).
  Commit your own files by name, never `git add -A`.
- `npm run check` failing on screenshots after a UI change is routine:
  fresh throwaway instance + `seed-wiki-instance.mjs` + `shoot-wiki.mjs <ids>`.
- `vite build` and `go build` must run from the repo root for the binary to
  embed the fresh `web/dist` (running them under `web/` builds nothing Go).

## Upstream / merge workflow (user conventions)

- Questionable changes are never pushed without the user: collect open
  questions and decide together (usually in the morning); keep them out of PRs.
- Deploy only on explicit request, through the separate deploy session.
- Registry deploy: images are built on the laptop and pushed to the Forgejo
  registry on the server; the server only pulls. `scripts/deploy-registry.sh`
  runs the whole cycle (`--kbrd`, `--both`, `--list`, `--rollback <tag>`).
  Image `git.emotera.ru/d-perelygin/salt.md`, tags `v<commit-count>-<sha>`.
  Server dirs `/opt/docker/salt-wiki` and `/opt/docker/salt-kbrd` keep the tag
  in `.env` (`IMAGE_TAG`); never pin it in their compose files, and do not
  build on the server any more.
- One commit per fix; commit named files only, never `git add -A` (it once
  staged committed conflict markers).
- Scratch dirs as `tmp/` inside the working dir, never `/tmp`.
- Take as much as possible from upstream; strip em-dash churn from new PRs and
  keep new prose in repo style. Never resurrect what the fork removed on
  purpose (`es.json`).
- Verify by execution: `go test`, `npm run check`, seed/shoot screenshots,
  CI status of every PR.
- When pulling upstream, the user's first attention is UX/UI: what changed
  visually and behaviorally. Present review lists split by kind (visual /
  experiential / security).
- Stack order: timeline (#64) first, calendar (#75) on top, shared code in one
  module (`viewSpan.tsx`, `SpanMode`, `formatMonthYear`).
- Backports: adapt tests to fork infrastructure (named feeds, SPA shell) and
  prove fail-before/pass-after for each regression test.
- Never touch others' state: foreign stashes, ports, sibling worktrees.

## Agent skills

### Issue tracker
GitHub Issues (fork `d-perelygin/salt.md`; upstream `saltmd/salt.md` canonical for PRs). See `docs/agents/issue-tracker.md`.

### Triage labels
Five canonical roles, defaults. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

### Feature flow
Single tree by default, worktree for large features. See `docs/agents/feature-flow.md`.
