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

## Agent skills

### Issue tracker
GitHub Issues (fork `d-perelygin/salt.md`; upstream `saltmd/salt.md` canonical for PRs). See `docs/agents/issue-tracker.md`.

### Triage labels
Five canonical roles, defaults. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

### Feature flow
Single tree by default, worktree for large features. See `docs/agents/feature-flow.md`.
