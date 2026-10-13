# AGENTS.md

## Build / run
- `make build` (frontend + backend), `./salt` → `:8420`
- Dev: `SALT_DATA=/tmp/salt-dev SALT_ADDR=:8420 go run .` + `cd web && npx vite`
- Go 1.25, Node 20; `CGO_ENABLED=0`, `-trimpath`; one binary embeds `web/dist`

## Verify (CI: `.github/workflows/ci.yml`)
- `go test ./...`
- `cd web && npm run check` (tsc + `check-*.mjs`; runs inside `npm run build`, unskippable)
- Source + comments in English only; source text is the translation key

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

## Agent skills

### Issue tracker
GitHub Issues (fork `d-perelygin/salt.md`; upstream `saltmd/salt.md` canonical for PRs). See `docs/agents/issue-tracker.md`.

### Triage labels
Five canonical roles, defaults. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

### Feature flow
Single tree by default, worktree for large features. See `docs/agents/feature-flow.md`.
