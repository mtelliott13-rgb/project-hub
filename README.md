# Project Hub

[![CI](https://github.com/mtelliott13-rgb/project-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/mtelliott13-rgb/project-hub/actions/workflows/ci.yml)

A local dashboard for everything I'm building with Claude: one card per project
showing its recent Claude Code sessions, claude.ai chats, git and CI status,
recently changed files, links, notes and ideas, with one click to pick up where
I left off.

![Project Hub home page, running on the sample data](docs/screenshot.png)

I use it every day on my own projects. The screenshot and `sample-data/` use made-up content so my job applications, chats and notes stay private.

**TypeScript · Hono · SQLite/Drizzle · React · Vite · Tailwind · Vitest**: 238 tests, CI on every push.

It runs on your own Mac, listens only on `127.0.0.1`, and keeps its data in
`~/.project-hub/`. Project data stays on this Mac. What goes out:

- **GitHub:** read-only `gh` requests (open PRs and the latest Actions run) for
  repos with a GitHub remote, every few minutes. The hub never fetches, pushes
  or writes anything there.
- **Claude, only when I click:** Monetize's Generate runs Claude Code, which
  sends the project files it reads to Claude and may search the web. Resume and
  the launch buttons open Claude Code or the Claude app, which then work as
  usual.

> **macOS only.** It opens sessions in Terminal.app and files in VS Code, starts
> at login through launchd, and learns about Claude Code sessions through Claude
> Code hooks. It isn't built or tested for Linux or Windows (CI runs the tests
> on Linux, but the app itself assumes a Mac).

## What it does

- **Projects** defined in `~/.project-hub/projects.yaml` (folders, repos, GitHub
  names, keywords). You can edit them from the page, and the page keeps your
  comments and layout. Hand edits show up live.
- **Claude Code sessions** filed to projects by folder, with running/ended
  state. **Resume** reopens the newest one in Terminal.app.
- **claude.ai chats** filed by Claude Project or title keywords, through a small
  Chrome extension (`extension/`) that sends only the chat id, title and project,
  never page text. Or import your claude.ai data export.
- **Repo status**: branch, uncommitted changes, ahead/behind, the last commits,
  open PRs and the latest GitHub Actions run (via `gh`). Read-only: it never
  fetches, commits or pushes.
- **Recent files**, **links** with an Inbox for anything unfiled, **notes**, an
  **Ideas** list, and **activity timelines**. Stale projects are dimmed.
- **Toolkit checklist**: a `toolkit.yaml` in a project shows "Toolkit: X of Y
  done" and a sortable list.
- **Applications**: works with Career HQ, my separate job-application tool. If
  a project holds its review queue, the page shows applications grouped
  draft → reviewed → submitted, fill sheets with copy buttons and character
  limits, and a job feed. Every application goes through my review: a status
  changes only when I pick it, a shortened answer is used only after I approve
  it, and each button runs one of Career HQ's own scripts on my click. The hub
  never edits Career HQ's files itself. "Fill application" starts Career HQ's
  form-filling session, which by Career HQ's rules stops before submit. I
  submit myself.
- **⌘K switcher**, and a read-only **MCP server** so Claude can ask what's going
  on in your projects.

## Privacy and security

- **Local only.** The server listens on `127.0.0.1` and checks every request's
  Host header, so other machines and DNS-rebinding pages can't reach it.
- **Token-checked API.** Every `/api/*` call except the health check and the
  live-update stream needs a token that the server puts into its own page.
  Writes and launches also must come from the hub's own origin. Claude Code
  hooks, the Chrome extension and the MCP server each have their own separate
  credential.
- **No prompt text.** Hook payloads pass through a schema that drops anything
  unknown. The hub stores session ids, folders, titles and times, never what
  I typed.
- **Read-only MCP.** The MCP server has five read-only tools over a GET-only
  `/agent` API with its own token, which refuses any request from a browser.
  Tests pin every tool and field it returns.
- **Application data stays on the page.** The review queue, fill sheets and job
  feed are never exposed through MCP or `/agent`, and neither are project
  notes or Monetize drafts. Tests check this.

## Built with AI-assisted development

I built this with Claude Code, spec first:

1. **Spec.** `SPEC.md` came first: the design, the stack and a plan in
   phases, each with a "Done when" check.
2. **Phases.** I built it one phase at a time (Phase 0 to 9, then smaller
   features), each in Claude Code. A phase was done only when its "Done when"
   check held and the tests passed. The commit history follows the phases.
3. **Working guide.** `CLAUDE.md` is the guide Claude Code reads every
   session: the rules (stay on the spec's stack, don't start a later phase
   early, never write `~/.claude/settings.json` without showing the diff) and
   how each finished part works.

## Try it with sample data

`sample-data/` is modeled on my own projects (Career HQ, Market Data Pipeline, a land
cover change detection class project, and Project Hub itself), but all of its
content is made up: notes, ideas, toolkit checklists, files and a fake Career HQ
application queue and job feed. It shows every section without your own data.
It runs on port 4748 and doesn't touch `~/.project-hub/` or read your Claude
Code sessions. The screenshot above is this sample data.

Needs Node.js 22.18 or newer, and pnpm (`corepack enable` turns it on).

```sh
git clone https://github.com/mtelliott13-rgb/project-hub.git
cd project-hub
pnpm install
pnpm build        # builds the web page into dist/web
pnpm sample       # starts the hub on the sample data
```

Then open:

- <http://127.0.0.1:4748/>: home page with the project cards
- <http://127.0.0.1:4748/p/career-hq>: Applications and Job feed
- <http://127.0.0.1:4748/p/land-cover>: Toolkit and notes
- <http://127.0.0.1:4748/ideas>: Ideas across all four projects

Press Ctrl+C in the terminal to stop it. A sample run writes its database and
tokens into `sample-data/`, and git ignores them.

## Run it for real

```sh
pnpm install
pnpm build
pnpm start        # http://127.0.0.1:4747
```

Optional pieces, each separate:

| Command | What it does |
|---|---|
| `pnpm agent:install` | Starts the hub at login (launchd agent `local.project-hub`). |
| `pnpm hooks:plan`, then `pnpm hooks:install` | Adds Claude Code hooks so sessions show up live. `hooks:plan` shows the change to `~/.claude/settings.json` first; `hooks:install` backs up the file before writing. |
| `pnpm mcp:plan`, then `pnpm mcp:install` | Registers the read-only MCP server with Claude Code and the Claude desktop app. |
| Chrome → Extensions → Load unpacked → `extension/` | Files your claude.ai chats. |

Each install has a matching `uninstall`.

## Development

```sh
pnpm dev          # server with reload + Vite on http://127.0.0.1:5173
pnpm test         # Vitest
pnpm typecheck
```

Stack: a Hono server running as plain TypeScript on Node (no build step for the
server), SQLite through Drizzle, React with Vite and Tailwind. `SPEC.md` is the
full design, built in phases; `CLAUDE.md` holds the working notes for each part.
