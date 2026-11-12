# Project Hub

The full spec is in [SPEC.md](SPEC.md). Read it before changing anything. We build it one phase at a time ("Do Phase N from SPEC.md, same rules"), and each phase ends with its "Done when" check.

Rules:
- Use the stack in SPEC.md unless you hit a concrete problem with it; if so, say so before switching.
- Don't start a later phase until asked.
- **"What's next"** means the open items in `~/.project-hub/ideas.md` (the hub's Ideas page), top first. Read that file, propose the next item, and when one is built, mark it done there: change `[ ]` to `[x]` and add ` · done YYYY-MM-DD` at the end of its line. Items scoped to a project slug are for that project; `hub` items are for this repo.

## This machine

- macOS (Apple Silicon), terminal app: **Terminal.app**, editor: **VS Code**. The Phase 2 launcher targets these.
- No Homebrew. Node.js 22 lives in `~/.local/node` (on PATH via `~/.zshrc`); pnpm comes from corepack. Install nothing that needs an admin password.
- `gh` lives in `~/.local/gh` (linked from `~/.local/bin/gh`), also installed without Homebrew.

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
- The card shows the branch's newest run as a coloured "CI passing / failing / running" link. `repoPoller` rechecks a repo every 30 s while it is `awaitingCi` (a run in progress, or the pushed HEAD has no run yet, including a first run when the checkout has `.github/workflows/*.yml`), at most 20 times in a row, so a finished run shows within about 30 s.

## Toolkit checklist

- A project with `toolkit.yaml` at the top level of one of its repos or folders gets "Toolkit: X of Y done" on its card (parked items don't count) and a Toolkit section on its page. Format: an `items:` list. Each item has:
  - `name`, `category`, `url` (linked only if http/https), `cost`, `why`
  - optional `target` (YYYY-MM-DD, flagged when past and not done/parked) and `notes` (shown under `why`)
  - optional `hours` (a number of 0 or more, or `ongoing`) and `time_note`
  - optional `priority` (high | medium | low) and `priority_why`
  - `status` (not started | in progress | done | parked; missing = not started)
- Odd `hours` or `priority` values are shown as written, flagged, and sorted with the blanks.
- Layout (`arrangeToolkit` in `web/src/toolkit-view.ts`): In progress first as its own group, then To do, Done and Parked. Each group is sorted by a "Fastest first | Priority" switch, remembered in localStorage:
  - Fastest first (the default): hours low to high, then `ongoing`, then blank.
  - Priority: high, medium, low, then blank, with ties fastest first.
  - File order breaks any remaining ties.
- Each row shows a coloured priority tag (high red, medium amber, low grey), the category as a small label, `priority_why` under the name, and hours with `time_note` beside it. Times under an hour show as minutes ("30 min").
- The file is the source of truth (Career HQ's lives in `~/career-hq`); the hub keeps no copy. `src/server/toolkit.ts` changes a status by replacing only that value's characters in the text (or adding one `status:` line), re-parses, and refuses unless nothing else changed. A write names the item by position and name plus the file version (sha256) the page loaded; if the file changed since, nothing is written and the 409 carries the current checklist. The first write to a file each hub run backs it up to `~/.project-hub/backups/toolkit/`.
- The hub watches `toolkit.yaml` in every active project folder (re-set when projects.yaml changes), including files that don't exist yet, so outside edits, new files and deletions reach the card and page without a restart.

## Applications (Career HQ review queue)

- A project with a review queue in one of its repos or folders gets an Applications section (cards grouped draft → reviewed → submitted, soonest deadline first, with fit, location, deadline, posting link) and a card line "Applications: 2 drafts · 1 reviewed · 3 submitted". The queue is `jobs/queue/review_queue.yaml` or `jobs/queue.yaml` (format: "Review queue format" in `~/career-hq/SPEC.md`). If both exist, the newer one is shown and the page warns about the other. The hub watches both paths, including before they exist. Rules shared with the page: `src/server/queue-rules.ts`. Reading: `src/server/applications.ts`. Routes: `src/server/application-routes.ts`.
- **The hub never writes the queue.** Career HQ rebuilds it from each packet's `meta.yaml`. A status change runs Career HQ's own command (`src/server/queue-status.ts`): `uv run python scripts/review_queue.py status <id> <status>`. It goes through `POST /api/launch` as kind `queue-status` (slug, id, status, queue version), so it gets every Phase 2 check plus `dryRun`. Before running, the server checks that:
  - the id is one the queue lists and matches `YYYY-MM-DD-lowercase-words`
  - the status is draft, reviewed or submitted
  - the version still matches (409 with the current queue if not)
  - `scripts/review_queue.py` is a regular file inside the repo (symlinks followed)
  - only one run per project is going
- How it runs: no shell, `~/.local/bin/uv` by full path (`UV_BIN`; tests use a fake), cwd the repo, a minimal environment, a 60 s timeout and a 64 KB output cap. It succeeds only if the command exits 0 *and* the re-read queue shows the new status. Otherwise the page shows the last 20 lines of output and the command to copy.
- Fill sheets come through the queue item's `packet` path. The hub reads `fill_sheet.json` when it exists (SPEC.md "Fill sheet JSON", read with zod: sections, fields with optional `group`, `chars` and `max_chars`, and notes with a `group`), else `fill_sheet.md` (headings, `**Label**` + fenced value, `>` notes). A JSON file that is broken, over 1 MB or in the wrong format falls back to the Markdown with a warning. An unknown `version`, or an `id` that doesn't match, is shown with a warning. Every field gets a Copy button except notes and values equal to `missing_marker`, which show as warnings. Where a field has `chars` or `max_chars`, the hub counts the value in code points (as Python does). It shows "N chars", or "N / max". It flags a `chars` that doesn't match the value, and an `over_limit` that disagrees with the count.
- Limits and shorter drafts (`max_chars`, `over_limit`, `shorter_draft` in the JSON; the "(N / M characters max)", **OVER THE LIMIT** and "Shorter draft, pending your approval" blocks in the Markdown, parsed into the same thing):
  - An over-limit field gets a red box, an "Over the limit by N… Don't paste this as-is" line and a red "Copy anyway" button, plus "No shorter version drafted yet" when there's no draft.
  - A pending draft shows under its field in a dashed violet box with its own count ("✓" when it fits, "still over by N" when not). It has **no** Copy button: it isn't approved until Career HQ makes it the value.
  - The sheet opens with a summary line ("2 fields over their limit · 1 shorter draft pending your approval") that jumps to the first one, and each application's card shows the same. `limitFlags` / `limitSummary` live in `queue-rules.ts`; `withLimits` adds the counts to the queue answer.
- **Approve** (a pending draft with Career HQ's `question` number that fits a known `max_chars`; never a draft that's still over, or one from the Markdown fallback) runs `uv run python scripts/review_queue.py approve-draft <id> <question> <sha256>`. It goes through `POST /api/launch` kind `approve-draft` with the same runner and checks as `status` (`queue-status.ts`):
  - `question` must be a JSON integer 1–9999, so it is always plain digits with no leading zero
  - `sha256` must be 64 lowercase hex characters
  - status changes and approvals share one lock per project
- **The page computes the hash** (`sha256Hex` in `queue-rules.ts`, Web Crypto) from the draft string exactly as it received and showed it. The server never re-reads the file for it, so Career HQ refuses a draft that changed after the page loaded.
- Success needs exit 0 *and* the fill sheet no longer showing that question's draft. The page shows Career HQ's one line; on failure, its `error:` line plus the command to copy. Either way the sheet and card reload, and nothing retries. Every Approve button is disabled while one runs.
- Tested live only on a scratch copy of Career HQ's scripts with its fictional sample packet. Never approve a draft in a real packet without asking the user.
- **Launch buttons** (Career HQ's `docs/project_hub_launch_buttons.md` and SPEC.md "Editing the cover letter in Word"). They use the same runner, checks, shared lock and `dryRun` as `status` (`queue-status.ts`, `CAREER_KINDS`), with a 90 s timeout:
  - **Open letter in Word** (kind `open-letter`, any card whose packet has `cover_letter.docx`) runs `review_queue.py open-letter <id>`. Career HQ opens the .docx in Microsoft Word and changes no file.
  - **Open resume in Word** (kind `open-resume`, any card whose packet has `resume.docx`) runs `review_queue.py open-resume <id>` the same way (SPEC.md "Editing the resume in Word"). The queue's `resume` field (`generated | edited | edited_pdf_outdated`, unknown values flagged) only decides the grey "Resume edited in Word" line.
  - **PDF check** (`src/server/pdf-check.ts`, `GET /api/projects/:slug/applications/:id/pdf-check`): whether `resume.pdf` and `cover_letter.pdf` are current comes only from Career HQ's upload-time check, `uv run python scripts/fill_plan.py files <id>` (SHA-256 fingerprints; never file dates, never the queue's `resume`/`letter` fields). Same runner rules (no shell, minimal env, script a regular file inside the repo), 30 s timeout, not under the button lock (read only), at most 2 at once, one per packet at a time. Answer per document: `current`, `outdated` (with Career HQ's note), `no-pdf`, or null without a .docx; anything odd (not JSON, wrong id, a path that isn't the packet's own PDF, failed exit, timeout) is an `error`, never current. Cached per packet until the stat (inode, size, mtime) of the packet's .docx/.pdf/state/yaml files or `resume/master_profile.yaml` changes, or 5 minutes pass; errors aren't cached. Dates only decide when to ask again. Each card with a .docx asks (react-query `pdf-check`, refetched on focus and after any Career HQ command). Outdated or no PDF: amber boxes for the resume (Rebuild PDF + copy command) and the letter (`letter_sync.py sync <id>` to copy); a failed check shows a grey "Couldn't check the PDFs" line.
  - **Rebuild PDF** (kind `resume-pdf`, any card with `resume.docx`) runs `uv run python scripts/resume_state.py pdf <id>` (`RESUME_SCRIPT`, also a regular file inside the repo), 120 s timeout. Inside the lock it first runs a fresh PDF check and refuses (409) if the resume is already current, or if the check fails. Success needs exit 0 and a fresh check listing resume.pdf as current (which also refreshes the cache).
  - **Fill application** (kind `launch-apply`, only when the queue shows exactly `reviewed`) runs `review_queue.py launch-apply <id>`. Career HQ opens a new Terminal window running `claude --chrome "/apply <id>"`. That skill fills the form, never clicks submit or anything submit-like, and stops for the user.
  - **Build packet** (kind `launch-build`, on Job feed postings) runs `review_queue.py launch-build <posting-id>`. Career HQ opens Terminal running `claude --chrome "/build-packet <posting-id>"`. The id must match Career HQ's `POSTING_RE` (`POSTING_ID` in `job-feed.ts`) and be exactly an id in the current feed.json, and the posting must have no packet. The id passed on is the feed's own string.
  - **Add a job** (box at the top of the Applications section, kind `launch-manual`) runs `review_queue.py launch-manual [--url <link>]` with the posting text on stdin (SPEC.md "Manual job input"; built 2026-11-10; checked against Career HQ main `2ae3abb` and its `docs/project_hub_launch_buttons.md`). One box: a single word is a link, anything else is posting text; with text, an optional "Posting link" is sent too, for Career HQ's duplicate check. `manualJobInput`, `httpsLinkProblem` and `postingTextProblem` in `queue-rules.ts` mirror Career HQ's `check_url` / `check_text` (https only, a host, no user name, no spaces or control characters, 2048 characters max; text not blank, no NUL or broken Unicode, 200,000 UTF-8 bytes max), and the server checks again. Text goes only to the command's stdin (`runCommand`'s `stdin`; a link alone gets an empty, closed stdin). It's never logged, stored, returned or written anywhere by the hub; a dry run gives only `stdinBytes`, and the copy command for text is `pbpaste | uv run …`. `/api/launch` bodies are capped at `LAUNCH_BODY_MAX` (1 MB, 413). Career HQ saves the text in its own `jobs/inbox/`. The page keeps the text in memory only and clears it on success. When Career HQ answers "that link already has a packet: <id>" and the queue lists that id, the answer carries `duplicate` (id, company, title) and the error shows "Go to <company · title>", which scrolls to that card (`application-<id>`) and outlines it. Uses the user's Claude usage, like the feed's Build packet; never build a real packet without asking.
  - The hub's call returns in seconds. The long, browser-driving session runs in that visible Terminal window, where the user can watch it and stop it. Both launches use the user's Claude plan usage (claude.ai sign-in), like any session, and show up as Career HQ sessions. Success shows Career HQ's one line; failure shows its `error:` line and the command to copy. All Career HQ buttons on the page share one react-query mutation key (`careerKey` in `web/src/project/career-launch.ts`), so they're all disabled while any one runs.
  - Tested live only on a scratch copy of Career HQ's scripts with `CLAUDE_BIN` pointed at a stub. Never click Fill application or Build packet on real data without asking the user.
- **Job feed** section (`src/server/job-feed.ts`, `web/src/project/JobFeedSection.tsx`, `GET /api/projects/:slug/job-feed`):
  - Reads `jobs/feed/feed.json` (SPEC.md "Job feed format") with lenient zod. Files over 5 MB aren't read, and an unknown format or version is shown with a warning.
  - Shows postings in the feed's order, with the new, reposted, "season not stated", open 30+ days and fit flags. Also shows a filter box, the first 25 rows with a "Show all" link, failed board runs, "Check these by hand" (`not_covered`) and attribution lines.
  - A posting has a packet when a queue item's `url` equals its `url` or `apply_url`, ignoring a trailing slash. Career HQ also matches `meta.yaml`'s `posting_id`, which the queue doesn't carry, so its own duplicate refusal still covers that case.
  - `/api/projects` has `jobFeed` (posting count, generated date), which decides whether the section shows. The hub watches the feed path like the queue.
  - Same privacy rules as the queue: no-store, page token only, never in `/agent` or MCP (tested).
- PDFs: launch kind `packet-file` (slug, id, `resume` | `cover-letter`) opens a PDF in Preview (never the default app), only for an id the queue lists and only if the file resolves, symlinks followed, inside the repo holding the queue.
- Private: queue, fill-sheet, feed and launch answers are `no-store` and page-token only. They are never exposed through `/agent` or the MCP tools (tested). Tests use made-up data only.

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

## Status and polish (Phase 8)

- `src/server/activity.ts` holds the rules as pure functions with type-only imports, so the page imports them too: `buildTimeline` (sessions the page lists, chats, commits once each, the newest CI run, recent files grouped by clock hour, filed links), `lastActivity` (newest event, never CI), `isStale` (14 days or more; no activity at all is not stale), `statusBadges` (running, CI failing, PRs waiting, uncommitted, to push, stale, counts summed across repos) and `sortProjects` (running first, then newest activity, then name).
- `GET /api/activity` gives every project's `{ last, stale }` for the home page; `GET /api/projects/:slug/activity?limit=` the timeline plus `total`. Both build on request from what the hub already has: commits are the last 10 per repo and files whatever the watcher holds (first-scan mtimes included). The SSE `files` topic refetches `activity` queries as well as `files`.
- Cards: "Last:" line, badges with lucide icons, a repo line without what the badges say, 3 sessions; stale cards are dimmed in place. The folder/GitHub/keyword rows live on the project page only. The Activity section is first on the project page.
- `web/src/Switcher.tsx`: ⌘K anywhere (also the nav's Find button), built on `cmdk`. Enter opens a project or page, ⌘Enter runs the project's Resume.
- cmdk 1.1.1 and lucide-react 1.59.0 are pinned exactly (lucide releases almost daily; pick versions at least two weeks old when upgrading).

## MCP server (Phase 9, read-only)

- `scripts/mcp.ts` is a stdio MCP server (`@modelcontextprotocol/sdk`, pinned) with five read-only tools defined in `src/server/mcp-server.ts`: `list_projects`, `get_project`, `recent_sessions`, `list_ideas`, `get_toolkit`. It opens no port; it calls the running hub's `/agent/v1/*` routes (`src/server/agent-routes.ts`) with `~/.project-hub/agent-token` (0600, created on hub start, read per call).
- `/agent/*` is GET only, needs `X-Agent-Token`, and refuses any request with `Origin` or `Sec-Fetch-Site` (so no web page can use it); the Host check applies as everywhere. The agent token works nowhere else, and the page and hook tokens don't work there. `get_toolkit` items include `hours`, `timeNote`, `priority` and `priorityWhy`. Never exposed: notes, Monetize drafts, file contents, tokens (and the hub stores no prompts). `test/phase9.test.ts` pins the tool list and every field returned, so exposing more fails a test until reviewed. Tool answers do go into the Claude conversation that asked.
- Registered as `project-hub` in Claude Code (user scope, `~/.claude.json`) and in the Claude desktop app (`claude_desktop_config.json`, full node path since the app doesn't read `~/.zshrc`; restart the app after changes). `pnpm mcp:plan` shows the diffs, `mcp:install` / `mcp:uninstall` back up and change only the hub's entries (`--only desktop,code,allow`). The `allow` part adds one `permissions.allow` rule per tool to `~/.claude/settings.json` (never a wildcard, so a future tool isn't pre-approved); like the hooks, show that diff and get an OK before writing it.
- Writes from MCP (adding links or notes) are not built; SPEC.md's Phase 9 lists them.

