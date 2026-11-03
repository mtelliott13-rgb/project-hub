# Project Hub

The full spec is in [SPEC.md](SPEC.md). Read it before changing anything. We build it one phase at a time ("Do Phase N from SPEC.md, same rules"), and each phase ends with its "Done when" check.

Rules:
- Use the stack in SPEC.md unless you hit a concrete problem with it; if so, say so before switching.
- Don't start a later phase until asked.
- **"What's next"** means the open items in `~/.project-hub/ideas.md` (the hub's Ideas page), top first. Read that file, propose the next item, and when one is built, mark it done there: change `[ ]` to `[x]` and add ` · done YYYY-MM-DD` at the end of its line. Items scoped to a project slug are for that project; `hub` items are for this repo.

## This machine

- macOS (Apple Silicon), terminal app: **Terminal.app**, editor: **VS Code**. The Phase 2 launcher targets these.
- No Homebrew. Node.js 22 lives in `~/.local/node` (on PATH via `~/.zshrc`); pnpm comes from corepack. Install nothing that needs an admin password.
- `gh` 2.102.0 lives in `~/.local/gh` (linked from `~/.local/bin/gh`), signed in as mtelliott13-rgb. career-hq, demo-dashboard and project-hub are private repos there (pushed 2026-10-21); each repo's git config has a repo-local credential helper that calls `gh auth git-credential`. meme-radar has no remote yet.

## Layout

- `src/server/` is the Hono server. It runs as plain TypeScript through Node's type stripping (no build step), so use `.ts` import extensions and only erasable syntax (no enums or parameter properties).
- `src/server/db/schema.ts` is the Drizzle schema. After changing it, run `pnpm db:generate` and commit the new file in `drizzle/`. Migrations apply on server start.
- `web/` is the Vite + React + Tailwind UI, built to `dist/web` and served by the server.
- `scripts/launch-agent.ts` is run-at-login (a launchd agent labelled `local.project-hub`).
- Runtime data lives in `~/.project-hub/`: `projects.yaml`, `hub.db`, `ideas.md`, `projects/<slug>/` (notes and Monetize drafts), `logs/hub.log`, `backups/`.

## Commands

- `pnpm test` runs the Vitest tests; `pnpm typecheck` checks types.
- `pnpm build` builds the UI; `pnpm start` runs the server on http://127.0.0.1:4747.
- `pnpm dev` runs the server with reload plus the Vite dev server on http://127.0.0.1:5173.
- `pnpm agent:install` / `agent:uninstall` / `agent:status` manage run-at-login. After pulling server changes, run `launchctl kickstart -k gui/$(id -u)/local.project-hub` to restart it.
- `pnpm hooks:plan` shows the `~/.claude/settings.json` diff without writing; `hooks:install` backs up to `~/.project-hub/backups/` and writes; `hooks:uninstall` removes only the hub's hooks. Never write that file without showing the diff and getting an OK first.

## Claude Code capture (Phase 1)

- Never store prompt text. Hook payloads go through a zod schema that drops unknown keys, and an SDK `summary` that is really the first prompt is treated as no title.
- `model` stays empty for now: this Claude Code version's SessionStart payload has no `model` field, and the transcript format is internal, so we don't read it.
- A session is `resumable` only once the Agent SDK lists it (a conversation was saved). The full listing every 5 minutes sets and clears the flag, and the 3-second lookup after hook activity sets it. Hooks also fire for sessions that never save a conversation (exited before the first message, or headless runs without persistence), so hooks alone never make one resumable. The API adds `resumeProblem` (no saved conversation, or the folder is gone); Resume picks the newest session without one, rows offer Terminal/Desktop only for those, and the launcher refuses the rest with 409.
- "Running" comes from SessionStart/Stop hooks plus `claude agents --json` every 15 s. A session that was listed and then disappears is marked ended.
- Known issue: under the hub, `claude agents --json` sometimes spins on CPU until the 15 s timeout, though it answers in ~0.2 s from a shell or a test launchd job. A failed poll changes nothing (hooks still update state), and polls never overlap.

## One-click launch (Phase 2)

- `POST /api/launch` takes ids and slugs only (`src/server/launcher.ts`); the server looks up every path and builds every argument, and a request's `path` must be one the project already lists. `dryRun: true` returns the exact command without running it.
- It accepts only the hub's own page (`hubPageRefusal` in `app.ts`): Origin must be the hub's (`HUB_ORIGINS`), `Sec-Fetch-Site` (when sent) `same-origin`, JSON body, and `X-Hub-Token` equal to `~/.project-hub/ui-token`, a token separate from the hook token. The server injects it into index.html (served `no-store`, unframeable). Every request must carry the hub's Host, which blocks DNS rebinding.
- Terminal launches write a one-shot `.command` file in `~/.project-hub/launch/` and `open -a Terminal` it, so no Automation permission is needed. VS Code opens with `open -a 'Visual Studio Code'` (no `code` CLI here). Chats and Claude Projects open in the Claude desktop app (`claude://`), as the user chose; https is only the fallback when Claude.app is missing.
- `pnpm dev` sets `PROJECT_HUB_DEV_ORIGIN` so the server also accepts Vite's page on 127.0.0.1:5173.

## Projects (Phase 3)

- `projects.yaml` is the source of truth. The page's Add, Edit, Archive, Unarchive and Delete write it (`src/server/projects-file.ts`, which edits only the named entry and keeps comments and layout, then parses the result back and refuses to save if it doesn't read back as intended), then reload from it. The previous version goes to `~/.project-hub/backups/projects.last.yaml`.
- The hub watches the file, so hand edits show up without a restart. A broken file leaves the last good state in place, and the page shows the error.
- `archived: true` hides a card; archived projects still file their sessions. A project removed from the file by hand is archived in the database, keeping its history. Delete from the page removes the YAML entry and the database row, so its sessions become unfiled. It never touches files on disk.
- `sessions: [id, …]` pins sessions to a project whatever their folder (for sessions run from `~` or another too-broad folder).
- Folders and repos are picked from a list (`src/server/folders.ts`): suggestions plus browsing, limited to the home folder. A new repo must contain `.git`, and paths a project already lists may be missing on disk (Meme Radar keeps `~/Documents/meme-radar` for an old session).
- Every `/api/*` write, and `/api/folders/*`, goes through `hubPageRefusal`, the same check `/api/launch` uses.

## Project pages (Phase 4)

- Routes: `/` (cards), `/p/<slug>` (project page), `/ideas`, `/inbox`, `/settings`. The page is built from `SECTIONS` in `web/src/project/sections.tsx`; a new section is one component plus one line there.
- Notes: `~/.project-hub/projects/<slug>/notes.md`. Monetize drafts: `projects/<slug>/monetize/<timestamp>.md`, one per Generate, all kept, each editable (front matter records when it was generated, its cost, and when it was edited). Both autosave; the page never refetches text you're editing.
- Generate runs only on click: `claude -p … --restricted --tools Read,Glob,Grep,WebSearch,WebFetch --permission-mode dontAsk --strict-mcp-config --no-session-persistence --output-format json` in the project's first existing repo or folder, with the others passed as `--add-dir` (`src/server/monetize.ts`). So it reads files and searches the web, can't edit or run commands, ignores user settings (no hooks fire), and saves no transcript. One run per project at a time; tests never run Claude.
- Every `/api/*` call needs the page token, except `GET /api/health` and `/api/events`.
- Deleting a project leaves its `projects/<slug>/` folder in place.

## Collectors (Meme Radar)

- A project can have a hand-edited `collector:` block in projects.yaml (`command` as an argument list, `port`, optional `status_url`); the page can't change it. Meme Radar's runs `caffeinate -i uv run python -m radar` in `~/meme-radar` on port 8000.
- It counts as running when a process listens on the port from inside the project's first repo (`src/server/collector.ts`, lsof/ps; tests use a fake probe). A listener from elsewhere shows as "port busy".
- Start and Stop are `/api/launch` kinds `collector-start` / `collector-stop` with only the slug, so they get the Phase 2 checks and `dryRun`. Start opens a Terminal window running the command and is refused while it runs (one copy only). Stop sends SIGINT (Ctrl+C) to that one process after a confirmation, and waits up to 15 s for it to exit.
- `GET /api/projects/:slug/collector` reports the state and the app's source health; the page's Collector section polls it every 5 s and is shown only for projects with a collector (`show` in `SECTIONS`).

## Repo and GitHub (Phase 5)

- `src/server/repos.ts`: per repo, `simple-git` for branch, upstream, uncommitted count, ahead/behind and the last 10 commits; `gh pr list` and `gh run list` for open PRs (with their checks) and the newest CI run on the branch. The GitHub repo comes from the `origin` remote. Read-only: the hub never fetches, commits or pushes, so "to pull" only counts what your last fetch saw.
- git runs with a minimal environment and `GIT_OPTIONAL_LOCKS=0` (allowed via simple-git's `allowEnvironment`), so polling never takes git's lock or rewrites the index while you work.
- `repoPoller` checks every active project's repos every 3 minutes and right after each Stop hook for the repo the session ran in; one check per repo at a time. Results are in memory and come with `/api/projects` as `repoStatus` (lined up with `repos`). `POST /api/projects/:slug/repos/refresh` checks now. Tests use real throwaway git repos and a fake `gh`.

## GitHub Actions

- `.github/workflows/ci.yml` ("CI") runs `pnpm typecheck` and `pnpm test` on ubuntu-latest for every push and PR; a newer push to a branch cancels its run in progress. Linux because the repo is private (macOS minutes count 10×); tests must not depend on macOS-only tools actually running. Action versions are pinned to releases at least a couple of weeks old (pnpm/action-setup to an exact tag).
- The card shows the branch's newest run as a coloured "CI passing / failing / running" link. `repoPoller` rechecks a repo every 30 s while it is `awaitingCi` (a run in progress, or the pushed HEAD has no run yet), at most 20 times in a row, so a finished run shows within about 30 s.

## Toolkit checklist

- A project with `toolkit.yaml` at the top level of one of its repos or folders gets "Toolkit: X of Y done" on its card (parked items don't count) and a Toolkit section on its page: in-progress items first as their own group, then each category in file order. Format: `items:` list of `name`, `category`, `url` (linked only if http/https), `cost`, `why`, optional `target` (YYYY-MM-DD, flagged when past and not done/parked), optional `notes` (shown under `why`), `status` (not started | in progress | done | parked; missing = not started).
- The file is the source of truth (Career HQ's lives in `~/career-hq`); the hub keeps no copy. `src/server/toolkit.ts` changes a status by replacing only that value's characters in the text (or adding one `status:` line), re-parses, and refuses unless nothing else changed. A write names the item by position and name plus the file version (sha256) the page loaded; if the file changed since, nothing is written and the 409 carries the current checklist. The first write to a file each hub run backs it up to `~/.project-hub/backups/toolkit/`.
- The hub watches `toolkit.yaml` in every active project folder (re-set when projects.yaml changes), including files that don't exist yet, so outside edits, new files and deletions reach the card and page without a restart.

## Files, links and Inbox (Phase 6)

- Recent files: `src/server/files.ts` watches every active project's repos and folders with chokidar 5 (6.0.0 was days old when this was built). Skipped: `IGNORED_DIRS` (.git, node_modules, build output, caches, .venv, .obsidian…), editor/OS litter and SQLite side files, and in a repo whatever git ignores (`git ls-files --ignored` at start, `git check-ignore --stdin` for new paths, both with `GIT_OPTIONAL_LOCKS=0`; a changed .gitignore restarts that folder). Meme Radar's `data/` (browser profile, radar.db) is skipped this way. Only names and mtimes are kept, in memory, about 200 per folder; the first scan seeds them. A file belongs to the project `matchProject` gives it. Watchers re-sync when projects.yaml changes and every minute.
- File changes send SSE `change` with data `files`, which refetches only the `files` queries; everything else sends `all`. Launch kind `file` opens a file in VS Code, only if it is in that project's recent list right now.
- Links: `links` and `link_rules` tables (`src/server/links.ts`, routes in `src/server/link-routes.ts`). A link files by the most specific match: exact host over a parent domain, then the longer path prefix (whole segments), a saved rule over a built-in on a tie. Built-ins: a project's `github:` repos and its `claude_project`. No match means the Inbox. Same page pasted twice (ignoring www, scheme and #fragment) is one row. Saving a rule files the Inbox links it matches; links already filed never move on their own. Projects.yaml changes re-run the Inbox matching. Deleting a project returns its links to the Inbox and drops its rules.
- Inbox page: unfiled links and unfiled sessions. ↑/↓ or j/k selects, 1–9 files into that project (active projects by name), A saves "always file these here" (links: the domain or its first path segments, owner/repo on GitHub; sessions: adds the session's folder to the project's `folders:` in projects.yaml, refused for ~, ~/Documents and similar), Z undoes a link filing. Filing a session without A pins it (`sessions:`). Links come in by paste for now (Inbox page, or a project's Links section, which files there directly); Phase 7's extension will add its own source.

## claude.ai chats (Phase 7)

- `extension/` is an unpacked Chrome extension (MV3). It asks for `activeTab`, host access to `http://127.0.0.1:4747/*` only, and a content script on `https://claude.ai/*` (all claude.ai pages, since claude.ai moves to /chat/<id> without reloading). `test/phase7.test.ts` pins these, so any change to what it asks for fails a test until it's reviewed. The content script (`chat-page.js` + `content.js`) reads the chat id from the URL, the title from the tab title, and the Claude Project from a `/project/<id>` link outside nav/aside (none if links disagree), once a second, and sends only on change. Never page text.
- Its ID (`ehkkllokbpjakamlnmnfnlgkgbageooh`) comes from the public `key` in manifest.json (no private key is kept; an unpacked extension doesn't need one). `config.extensionId()` derives it, and `/ext/*` (`src/server/chat-routes.ts`) answers only JSON POSTs with `Origin: chrome-extension://<that id>`: web pages and other extensions can't send that Origin. `/ext/*` doesn't use the page token.
- `chats` and `claude_projects` tables (`src/server/chats.ts`). A chat files by its Claude Project (a mapping on /settings wins over projects.yaml's `claude_project`), else the active project with the longest keyword in its title as whole words (a tie goes to the Inbox), else the Inbox. Chats filed by hand (`manual`) stay put; everything else re-files when projects.yaml or a mapping changes. Deleting a project returns its chats to the Inbox and clears its mappings. Resume opens the newer of the newest reopenable session and the newest chat.
- Import (Settings): the claude.ai export .zip (read with `/usr/bin/unzip`) or its conversations.json, uploaded to a private temp folder that is deleted afterwards. Only chat uuid, name, created/updated dates and project uuid (`project_uuid` or `project.uuid`, if the export has them) are kept, plus Claude Project names from projects.json. `hubPageRefusal` accepts `application/zip` on that one route (a form can't send it either).
