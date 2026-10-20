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
- Known issue: under the hub, `claude agents --json` sometimes spins on CPU until the 15 s timeout, though it answers in ~0.2 s from a shell or a test launchd job. A failed poll changes nothing (hooks still update state), and polls never overlap.

## One-click launch (Phase 2)

- `POST /api/launch` takes ids and slugs only (`src/server/launcher.ts`); the server looks up every path and builds every argument, and a request's `path` must be one the project already lists. `dryRun: true` returns the exact command without running it.
- It accepts only the hub's own page: Origin must be the hub's (`HUB_ORIGINS`), `Sec-Fetch-Site` (when sent) `same-origin`, JSON body, and `X-Hub-Token` equal to `~/.project-hub/ui-token`, a token separate from the hook token. The server injects it into index.html (served `no-store`, unframeable). Every request must carry the hub's Host, which blocks DNS rebinding.
- Terminal launches write a one-shot `.command` file in `~/.project-hub/launch/` and `open -a Terminal` it, so no Automation permission is needed. VS Code opens with `open -a 'Visual Studio Code'` (no `code` CLI here). Chats and Claude Projects open in the Claude desktop app (`claude://`), as the user chose; https is only the fallback when Claude.app is missing.
- `pnpm dev` sets `PROJECT_HUB_DEV_ORIGIN` so the server also accepts Vite's page on 127.0.0.1:5173.
