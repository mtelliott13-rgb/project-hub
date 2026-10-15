# Project Hub

The full spec is in [SPEC.md](SPEC.md). Read it before changing anything. We build it one phase at a time ("Do Phase N from SPEC.md, same rules"), and each phase ends with its "Done when" check.

Rules:
- Use the stack in SPEC.md unless you hit a concrete problem with it; if so, say so before switching.
- Don't start a later phase until asked.

## This machine

- macOS (Apple Silicon), terminal app: **Terminal.app**, editor: **VS Code**. The Phase 2 launcher targets these.
- No Homebrew. Node.js 22 lives in `~/.local/node` (on PATH via `~/.zshrc`); pnpm comes from corepack. Install nothing that needs an admin password.
- `gh` is not installed yet; Phase 3 needs it.

## Layout

- `src/server/` is the Hono server. It runs as plain TypeScript through Node's type stripping (no build step), so use `.ts` import extensions and only erasable syntax (no enums or parameter properties).
- `src/server/db/schema.ts` is the Drizzle schema. After changing it, run `pnpm db:generate` and commit the new file in `drizzle/`. Migrations apply on server start.
- `web/` is the Vite + React + Tailwind UI, built to `dist/web` and served by the server.
- `scripts/launch-agent.ts` is run-at-login (a launchd agent labelled `local.project-hub`).
- Runtime data lives in `~/.project-hub/`: `projects.yaml`, `hub.db`, `logs/hub.log`.

## Commands

- `pnpm test` runs the Vitest tests; `pnpm typecheck` checks types.
- `pnpm build` builds the UI; `pnpm start` runs the server on http://127.0.0.1:4747.
- `pnpm dev` runs the server with reload plus the Vite dev server on http://127.0.0.1:5173.
- `pnpm agent:install` / `agent:uninstall` / `agent:status` manage run-at-login. After pulling server changes, run `launchctl kickstart -k gui/$(id -u)/local.project-hub` to restart it.
- `pnpm hooks:plan` shows the `~/.claude/settings.json` diff without writing; `hooks:install` backs up to `~/.project-hub/backups/` and writes; `hooks:uninstall` removes only the hub's hooks. Never write that file without showing the diff and getting an OK first.

## Claude Code capture (Phase 1)

- Never store prompt text. Hook payloads go through a zod schema that drops unknown keys, and an SDK `summary` that is really the first prompt is treated as no title.
- `model` stays empty for now: this Claude Code version's SessionStart payload has no `model` field, and the transcript format is internal, so we don't read it.
- "Running" comes from SessionStart/Stop hooks plus `claude agents --json` every 15 s. A session that was listed and then disappears is marked ended.
