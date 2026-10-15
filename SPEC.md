# Project Hub: Options, Recommendation & Build Plan

Oct 14, 2026 · @Matthew Elliott

## Bottom line

Build a small local Project Hub with Claude Code, and keep your chats in claude.ai Projects, one per project. The hub is an index and a launcher, not a second place to work. Each project card has one Resume button that reopens your last Claude Code session or chat, with the repo, files and links one click away.

Claude Code sessions, repo state, pull requests, CI results and local files feed the hub on their own. claude.ai chats are the one real gap: there is no API for chat history. Chats get linked by starting them inside the right Claude Project, plus a small browser extension that catches the rest.

Cost is $0 beyond your Claude plan; expect two or three evenings with Claude Code using the build plan below. Anthropic's redesigned Projects (beta since September 17, 2026) already covers part of this for cloud Claude Code work, so the hub links to it rather than competing with it.

## Options compared

Four realistic routes. They differ less in how the dashboard looks than in how much fills itself, and whether one click can actually reopen a session.

| Option | Cost per month | Setup | Updates itself | One-click resume | On your phone |
| --- | --- | --- | --- | --- | --- |
| A. Claude-native Projects | Included in Pro or Max | Under an hour | High inside Claude, nothing outside it | Chats and cloud threads | Yes |
| B. Notion or Airtable | $0–20 | 1–2 days | Medium, and only after you write capture scripts | Links only | Yes |
| C. Obsidian vault | $0–4 | Half a day to a day | Medium for code, low for the rest | Links only | With Sync |
| D. Custom local hub (recommended) | $0 | 2–3 evenings | Highest: sessions, repo and files are automatic | Terminal, desktop app and chats | Via Tailscale |

### A. Claude-native: chat Projects plus the new Claude Code Projects

One claude.ai Project per project holds chats, files and instructions. If your account has the beta, a Claude Code Project adds a coordinating conversation whose Overview pane sorts threads into Ready for review, Waiting on you, Working and similar states, with a Library of files and a list of PRs.

- **Pros:** nothing to build; status keeps itself current for cloud threads; each project has its own memory; `claude://` links open a Project or chat directly.
- **Cons:** chat Projects and Code Projects are separate, with no dashboard across projects. Code Projects are a beta for select Pro and Max accounts, and sessions you start yourself in a terminal can't be added. Chats outside a Project aren't linked, and there's no home for repo health, local folders or outside links.

### B. Notion or Airtable database

A Projects database with related Sessions, Chats and Links tables, kept current by scripts that call the API.

- **Pros:** polished on every device and easy to share; both have Claude connectors, so Claude can read and write the hub; Notion Agent can draft updates on the Business plan.
- **Cons:** nothing updates itself until you write the same capture code as option D, now with an API in the middle. It can't launch a terminal, and `claude://` or `claude-cli://` links may not be clickable, so resume needs a localhost redirect. Notion Plus is $10 per member per month billed yearly, Notion Agent needs Business at $20, and Airtable Team is $20 per seat billed yearly.

### C. Obsidian vault

One Markdown note per project in a local vault. Claude Code hooks append session entries, and a Bases or Dataview table builds the dashboard.

- **Pros:** local plain files, free, and Claude Code can edit the notes directly; a good home for long-lived docs.
- **Cons:** still needs hooks and scripts; the dashboard is a query over notes, so no live "session running" or CI badges without more code; resuming needs a plugin that runs commands. Obsidian Sync, for phone access, is $4 per month billed yearly.

### D. Custom local hub built with Claude Code

A small web app on your machine with a SQLite database, fed by Claude Code hooks, a git and GitHub poller, a folder watcher and a browser extension.

- **Pros:** reads sessions, repos and files where they already live; can run `claude --resume <id>` in your terminal, which a hosted tool can't; shaped exactly to your projects; free.
- **Cons:** you own the upkeep when Claude Code or claude.ai change; desktop-first, so phone access needs Tailscale or similar; chats still rely on Projects plus the extension.

## Recommendation: D, layered on top of Claude Projects

Build the custom local hub, and use claude.ai Projects as the container for chats rather than trying to replace them. Four reasons:

1. **Your test is "click and be back in it."** For Claude Code that means running `claude --resume <session-id>` in the right folder. Only software on your machine can launch that; Notion and Obsidian can only show a link.
2. **Most of the data is already local.** Claude Code sessions, git state and project files live on your computer, so a local app reads them directly instead of syncing them to a service first.
3. **No option fully automates chats.** claude.ai has no chat-history API, so every route needs the same workaround: start chats inside a Claude Project. That costs the same under any hub, so it doesn't favor A, B or C.
4. **Claude Code can build it and keep changing it.** The plan below is sized for a few sessions, and you can reshape the hub whenever your workflow shifts.

Choose differently if:

- **You mostly work from your phone, or share projects with others:** pick Notion (B), with a small local script for the Claude Code hooks.
- **Most of your coding already runs as Claude Code cloud sessions and you have the Projects beta:** use A for those projects and let the hub simply link to them.

The hub treats native Projects as first-class links. When Anthropic brings the redesigned Projects to chat (announced, no date yet), you can retire pieces of the hub instead of migrating off it.

## Structure of a project entry

Each project is one record plus a few linked lists. Everything attaches through something the hub can match without you: a folder path, a GitHub repo or a Claude Project ID.

| Part | What it holds | How items attach | Kept current by |
| --- | --- | --- | --- |
| Identity | Name, short slug, colour, pinned, archived | You, once | — |
| Match rules | Repo paths, folders, GitHub `owner/repo`, Claude Project link, keywords | You, once; the hub proposes new repos it sees | — |
| Claude Code sessions | Session ID, title, folder, branch, where it ran, last active, running now | The session's working folder sits inside a project path | Hooks, live |
| Claude chats | Title, link, which Claude Project it's in | Its Claude Project, else title keywords, else Inbox | Extension, when you open a chat |
| Repo | Branch, uncommitted files, ahead/behind, recent commits, open PRs, CI result | Repo path | Poll every 3 minutes and after each Claude turn |
| Files | Recently changed files in the project's folders | Folder path | File watcher, live |
| Docs and links | Google Docs, Figma, artifacts, tickets, any URL | Domain or path rules, else Inbox | Extension button or paste |
| Status | Badges: session running, PR waiting, CI failing, uncommitted work, stale | Computed from the rows above | Live |
| Activity | One timeline of everything above | — | Live |

Anything the hub can't match lands in a single **Inbox**. Filing an item takes one keystroke and offers to save a rule, so the next similar item files itself.

### The one-click actions

| Button | What it does |
| --- | --- |
| Resume | Reopens whichever was touched last: the latest session or the latest chat |
| Resume session | Opens your terminal in the session's folder and runs `claude --resume <session-id>` |
| Open in desktop app | On macOS or Windows, runs `claude --desktop --resume <session-id>` |
| New session here | Opens `claude-cli://open?cwd=<repo path>`, Claude Code's own deep link |
| Open chat | `claude://claude.ai/chat/<id>` in the desktop app, or the https link in a browser |
| New chat in project | `claude://claude.ai/project/<id>`, so the chat starts inside the right Project |
| Session behind this PR | Runs `claude --from-pr <number>` in the repo |
| Open repo | Opens the folder in your editor |

## Automation: how things get in

Claude Code, git and files capture themselves. Chats and web links need the browser or one click, and a few things can't be automated today.

> **Diagram: "Most sources feed the hub on their own; chats and links need the browser"** (described in text)
>
> Three columns: *Where work happens* → *What captures it* → *One click back in*. Five sources on the left feed a central **Project Hub** box (runs on localhost, SQLite database; matches each item by folder, repo or Claude Project; no match goes to the Inbox, where filing it once creates a rule that files the next; status computed from all of it).
>
> - Solid arrows (automatic): **Claude Code sessions** (terminal, desktop app, IDE) via *hooks, live*; **Git and GitHub** (branches, commits, PRs, CI) via *git + gh poll*; **Project folders** (files you and Claude change) via *folder watcher*.
> - Dashed arrows (captured when you open it in Chrome, or with one click): **claude.ai chats** (opened in Chrome) via *browser extension*; **Docs and web links** (Drive, Figma, artifacts) via *extension button*.
> - On the right, the hub offers four one-click actions: **Resume session** (in terminal or desktop), **Open chat** (or its Claude Project), **Open repo** (in your editor), **New session here** (in the project folder).

capture paths · 5 sources, 4 one-click actions

Solid lines need nothing from you; dashed lines depend on opening the item in Chrome or one click.

| Source | How it's captured | Your effort |
| --- | --- | --- |
| Claude Code in the terminal, desktop app or IDE | User-level hooks in `~/.claude/settings.json` send SessionStart, Stop and SessionEnd events to the hub with the session ID, folder and transcript path. The folder decides the project. | None after setup |
| Older sessions and their titles | The Agent SDK's `listSessions()` and `getSessionInfo()` backfill history and refresh titles every few minutes | None |
| Background sessions running now | `claude agents --json` lists them | None |
| Git, PRs and CI | `git status` and `git log` per repo, plus `gh pr list` and `gh pr checks` | None |
| Project folders | A file watcher on each registered folder | None |
| New claude.ai chats | The hub's "New chat in project" button starts them inside the right Claude Project. A Chrome extension records the link, title and Project of every chat you open. | Use the button |
| Older chats | Import the file from Settings > Privacy > Export data | One click, rarely |
| Docs and web links | Extension button "Add to project", with the likely project pre-selected | One click |

### What can't be automated today, and the least-effort workaround

1. **claude.ai has no API or webhook for chat history.** Start chats from the hub's project button so they land in the right Claude Project. The extension files strays or drops them in the Inbox, and claude.ai's bulk "Move to project" cleans up the rest in a couple of minutes a week.
2. **A browser extension can't see chats in the desktop or mobile apps.** Started inside a Claude Project, they're still grouped there, and the hub's link to that Project shows them. A monthly export import fills in the hub's own list.
3. **Claude Code cloud sessions don't report to hooks on your machine.** They run in the cloud and don't read your `~/.claude` settings. Their branches and PRs still show up through `gh`; paste a session link to pin it, or use the Projects beta, which tracks cloud threads natively.
4. **Claude Code deletes local transcripts after 30 days by default.** Older sessions then can't be resumed from any hub. Set `cleanupPeriodDays` to 365; the installer in the build plan does this.
5. **Claude Code's deep link can't resume a session by ID.** `claude-cli://open` only takes a folder, a GitHub repo and a prompt, so the hub launches the terminal itself.
6. **The extension reads claude.ai pages, which change.** If its Project lookup breaks, chats fall into the Inbox instead of disappearing.

You asked for no summaries, so status is facts only: what ran, what changed, what's waiting. If you ever want one line per project, the Stop hook already carries Claude's last message.

## Build plan for Claude Code

Hand this to Claude Code one phase at a time. Each phase ends with a check you can run in under a minute, so a wrong turn costs one phase, not the whole build.

### Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript, pnpm | One language for server, UI and extension |
| Server | Hono on `@hono/node-server`, bound to `127.0.0.1:4747` | Small, fast, reachable only from your machine |
| Database | SQLite via `better-sqlite3`, with Drizzle ORM migrations | One file, no service to run |
| Claude Code data | Command hooks, `@anthropic-ai/claude-agent-sdk` (`listSessions`, `getSessionInfo`), `claude agents --json` | Documented interfaces; the raw transcript format is internal and changes between versions |
| Git and GitHub | `simple-git`, plus the `gh` CLI via `execa` | Reuses your existing GitHub login |
| Files | `chokidar` | Cross-platform folder watching |
| UI | Vite, React, Tailwind, TanStack Query, server-sent events, `cmdk` | Live dashboard and a Cmd-K project switcher with little code |
| Browser capture | Chrome extension, Manifest V3 | Sees claude.ai chats and adds links |
| Launcher | macOS: a `.command` file or AppleScript for iTerm2 or Ghostty; Windows: `wt`; Linux: `$TERMINAL` | Opens a real terminal running `claude --resume` |
| Always on | launchd agent (macOS), Task Scheduler (Windows) or a systemd user unit (Linux) | The hub is up whenever you're logged in |
| Tests | Vitest | Covers matching rules, parsers and the launcher's command building |

### Project list

```yaml
# ~/.project-hub/projects.yaml
projects:
  - slug: acme-site
    name: Acme website
    repos: [~/code/acme-site]
    folders: [~/Documents/Acme]
    github: [yourname/acme-site]
    claude_project: https://claude.ai/project/<project-uuid>
    keywords: [acme, landing page]
```

The hub reads this file at start and lets you edit it from the UI. Everything it learns (sessions, chats, rules) lives in the database.

### Hook setup (Phase 1 installs this)

```sh
#!/bin/sh
# ~/.project-hub/hub-hook.sh
# Forwards the hook's JSON to the hub. Prints nothing and never fails,
# so Claude Code is never slowed or blocked when the hub is down.
TOKEN=$(cat "$HOME/.project-hub/token" 2>/dev/null)
curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' -H "X-Hub-Token: $TOKEN" --data-binary @- http://127.0.0.1:4747/hooks/claude || true
exit 0
```

```json
{
  "cleanupPeriodDays": 365,
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "$HOME/.project-hub/hub-hook.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "$HOME/.project-hub/hub-hook.sh", "async": true }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "$HOME/.project-hub/hub-hook.sh" }] }]
  }
}
```

Three details matter. SessionStart accepts only command (and MCP tool) hooks, not HTTP hooks. Anything a SessionStart hook prints is added to Claude's context, hence `-o /dev/null`. SessionEnd hooks share a 1.5-second budget, hence `-m 1`.

### Phases

1. **Phase 0, scaffold.** Repo with `SPEC.md` (this doc) and a `CLAUDE.md` that points to it. Server, empty UI, SQLite migrations, the `projects.yaml` loader and run-at-login. *Done when:* http://127.0.0.1:4747 shows one card per project in the YAML.
2. **Phase 1, Claude Code capture.** A token-checked `POST /hooks/claude` stores session ID, folder, transcript path, title, model and timestamps; it never stores prompts. An installer backs up `~/.claude/settings.json`, merges in the hooks above and sets `cleanupPeriodDays`. Folder matching uses the longest path prefix and treats `.claude/worktrees/*` as its parent repo. Backfill with `listSessions()`, refresh titles every 5 minutes, and mark running sessions from `claude agents --json`. *Done when:* starting `claude` in a project repo shows "running" on its card within 2 seconds, exiting shows "ended", and last month's sessions are listed.
3. **Phase 2, one-click launch.** `POST /api/launch` with kinds `session`, `desktop`, `new-session`, `chat`, `claude-project`, `editor` and `from-pr`, behind an OS-specific launcher. Accept launches only from the hub's own page (same origin plus the token). The Resume button picks the most recent session or chat. *Done when:* Resume reopens yesterday's session, with its full history, in your terminal.
4. **Phase 3, repo and GitHub.** Poll each repo every 3 minutes and after every Stop event: branch, uncommitted count, ahead/behind, last 10 commits, open PRs and CI state from `gh`. *Done when:* a push and a new PR appear on the card within 3 minutes.
5. **Phase 4, files, links and Inbox.** Watch project folders, ignoring `.git`, `node_modules` and build output. Add a links table with domain and path rules, and an Inbox page with one-key filing and "always file these here". *Done when:* a saved file shows under Recent within 5 seconds, and filing an Inbox item creates a rule that works on the next one.
6. **Phase 5, claude.ai chats.** A Chrome extension that, on `https://claude.ai/chat/*`, sends the chat ID, title and Project ID (from the page's link to `/project/...`, when present) to the hub, and again when the title changes. Its popup has "Add this tab to project". Add an importer for the claude.ai data export and a settings page that maps Claude Project IDs to hub projects. *Done when:* opening a chat in Chrome puts it under the right project, or the Inbox, within 5 seconds.
7. **Phase 6, status and polish.** Status rules, cards sorted by last activity, the Cmd-K switcher, a per-project timeline and a "stale after 14 days" badge. *Done when:* the home page answers "where was I?" at a glance.
8. **Phase 7, optional.** Phone access over Tailscale; a small MCP server so Claude Code can add links or notes to the hub; one test of a scheduled Claude task that searches your chat history and posts new chats to the hub, treated as an experiment rather than a dependency.

### First prompt to paste into Claude Code

Export this doc as Markdown, save it as `SPEC.md` in an empty folder, run `claude` there and paste:

```text
Read SPEC.md. We're building the Project Hub it describes, one phase at a time.
Start with Phase 0 only. Before writing the launcher or run-at-login pieces, ask me
for my OS, terminal app and editor. Use the stack in the spec unless you hit a
concrete problem with it; if so, tell me before switching. Finish by running the
phase's "Done when" check and showing me how to verify it myself.
```

For each later phase: "Do Phase N from SPEC.md, same rules." With Codex the spec works as is; point an `AGENTS.md` at it instead of `CLAUDE.md`.

## Before you start

Six decisions shape the build; the first two are the only ones Claude Code will ask about.

- [ ] Your OS, terminal app and editor, since the launcher depends on them
- [ ] Your project list: names, repo paths, folders and GitHub repos for `projects.yaml`
- [ ] One claude.ai Project per hub project, then bulk-move existing chats into them, including this one
- [ ] Whether chats should open in the desktop app or the browser by default
- [ ] Whether **Projects** appears in the sidebar at claude.ai/code (the beta), and if so which projects live there
- [ ] Phone access now or later

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code: manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code: launch sessions from links (`claude-cli://`)](https://code.claude.com/docs/en/deep-links)
- [Claude Code: use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code Projects (beta)](https://code.claude.com/docs/en/claude-projects)
- [Agent SDK: work with sessions (`listSessions`, `getSessionInfo`)](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Projects redesigned: from folder to conversation](https://claude.com/blog/projects-redesigned)
- [Open Claude Desktop with a link (`claude://`)](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
- [Moving chats into Projects](https://support.claude.com/en/articles/9519177)
- [Export your Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)
- [Notion pricing](https://www.notion.com/pricing)
- [Airtable pricing](https://www.airtable.com/pricing)
- [Obsidian pricing](https://obsidian.md/pricing)
