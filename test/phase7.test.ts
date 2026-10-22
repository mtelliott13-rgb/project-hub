// Phase 7: claude.ai chats from the Chrome extension, Claude Project mappings
// and the data-export import. No test talks to claude.ai or Chrome.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { matchChat } from '../src/server/chats.ts';
import { EXTENSION_DIR, extensionId, MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { EXTENSION_ID, HUB, PAGE_GET, testDeps } from './helpers.ts';

type ChatPage = {
  chatId: (p: string) => string | null;
  title: (t: string) => string | null;
  projectId: (doc: unknown) => string | null;
  read: (loc: { pathname: string }, doc: unknown) => unknown;
};
let page: ChatPage;
beforeAll(async () => {
  // A plain script (Chrome loads it as is), so it's imported by path for its side effect.
  await import(/* @vite-ignore */ pathToFileURL(path.join(EXTENSION_DIR, 'chat-page.js')).href);
  page = (globalThis as unknown as { HubChatPage: ChatPage }).HubChatPage;
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const C1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const C2 = '11111111-aaaa-4bbb-8ccc-000000000002';
const P_RADAR = '22222222-aaaa-4bbb-8ccc-000000000001';
const P_OTHER = '22222222-aaaa-4bbb-8ccc-000000000002';

const yaml = `projects:
  - slug: radar
    name: Meme Radar
    keywords: [meme radar]
    claude_project: https://claude.ai/project/${P_RADAR}

  - slug: kratos
    name: Kratos
    keywords: [kratos]
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
  dirs.push(dir);
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  fs.writeFileSync(t.projectsFile, yaml);
  t.store.reload();
  const app = createApp(t.deps);
  const ext = { Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json' };
  const hubPage = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
  const send = async (url: string, method: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(`${HUB}${url}`, { method, headers, body: (body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit | undefined });
    return { status: res.status, body: await res.json() };
  };
  const fromExt = (url: string, body: unknown) => send(url, 'POST', ext, body);
  const call = (method: string, url: string, body?: unknown) => send(url, method, method === 'GET' ? PAGE_GET : hubPage, body);
  const chat = async (id: string) => {
    const inbox = (await call('GET', '/api/inbox')).body.chats as { id: string }[];
    const filed = ((await call('GET', '/api/projects')).body as { chats: { id: string }[] }[]).flatMap((p) => p.chats);
    return [...inbox, ...filed].find((c) => c.id === id);
  };
  return { dir, db, t, app, send, fromExt, call, chat, ext, hubPage };
}

describe('the extension: what it asks Chrome for', () => {
  it('asks only for activeTab, the hub at 127.0.0.1:4747, and a content script on claude.ai', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
    expect(m.permissions).toEqual(['activeTab']);
    expect(m.host_permissions).toEqual(['http://127.0.0.1:4747/*']);
    expect(m.content_scripts).toEqual([{ matches: ['https://claude.ai/*'], js: ['chat-page.js', 'content.js'], run_at: 'document_idle' }]);
    expect(Object.keys(m).sort()).toEqual(['action', 'background', 'content_scripts', 'description', 'host_permissions', 'key', 'manifest_version', 'name', 'permissions', 'version']);
    // Its ID is fixed by the key in the manifest, which is the ID the hub accepts.
    expect(extensionId()).toBe('ehkkllokbpjakamlnmnfnlgkgbageooh');
  });

  it('its scripts reach only the hub, and the claude.ai scripts read no page text beyond the tab title', () => {
    for (const f of fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(EXTENSION_DIR, f), 'utf8');
      for (const url of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) expect(url).toMatch(/^(http:\/\/127\.0\.0\.1:4747|https:\/\/claude\.ai)/);
      expect(src).not.toMatch(/chrome\.storage|chrome\.cookies|chrome\.history|XMLHttpRequest|WebSocket/);
    }
    // The content scripts (the only code that runs on claude.ai) look at the URL, the tab title and link addresses.
    for (const f of ['chat-page.js', 'content.js']) {
      expect(fs.readFileSync(path.join(EXTENSION_DIR, f), 'utf8')).not.toMatch(/innerText|textContent|innerHTML|outerHTML|\.value\b|getSelection/);
    }
  });
});

describe('reading a claude.ai chat page', () => {
  // A stand-in for the page: anchors with an href and an optional nav/aside parent.
  const doc = (title: string, links: { href: string; inNav?: boolean }[]) => ({
    title,
    querySelectorAll: () => links.map((l) => ({ getAttribute: () => l.href, closest: () => (l.inNav ? {} : null) })),
  });

  it('takes the chat id from the URL and the title from the tab, without the " - Claude" ending', () => {
    expect(page.chatId(`/chat/${C1.toUpperCase()}`)).toBe(C1);
    expect(page.chatId('/new')).toBeNull();
    expect(page.chatId(`/project/${P_RADAR}`)).toBeNull();
    expect(page.title('Pricing ideas - Claude')).toBe('Pricing ideas');
    expect(page.title('Claude')).toBeNull();
    expect(page.title('New chat - Claude')).toBeNull();
    expect(page.read({ pathname: '/recents' }, doc('Claude', []))).toBeNull();
  });

  it("takes the Claude Project from the page's /project/ link, ignoring the sidebar, and gives up if links disagree", () => {
    expect(page.projectId(doc('x', [{ href: `/project/${P_RADAR}` }, { href: `/project/${P_OTHER}`, inNav: true }]))).toBe(P_RADAR);
    expect(page.projectId(doc('x', [{ href: `https://claude.ai/project/${P_RADAR}/` }, { href: `/project/${P_RADAR}` }]))).toBe(P_RADAR);
    expect(page.projectId(doc('x', [{ href: `/project/${P_RADAR}` }, { href: `/project/${P_OTHER}` }]))).toBeNull();
    expect(page.projectId(doc('x', [{ href: '/projects' }]))).toBeNull();
    expect(page.read({ pathname: `/chat/${C1}` }, doc('Plan - Claude', [{ href: `/project/${P_RADAR}` }]))).toEqual({ chatId: C1, title: 'Plan', projectId: P_RADAR });
  });
});

describe('filing chats', () => {
  const projects = [
    { slug: 'radar', keywords: ['meme radar', 'radar'], claudeProject: `https://claude.ai/project/${P_RADAR}`, archived: false },
    { slug: 'kratos', keywords: ['kratos'], claudeProject: null, archived: false },
    { slug: 'old', keywords: ['pricing'], claudeProject: null, archived: true },
    { slug: 'dash', keywords: ['dashboard', 'tiktok'], claudeProject: null, archived: false },
  ];
  it('its Claude Project first (a mapping beats projects.yaml), then title keywords as whole words, else the Inbox', () => {
    expect(matchChat({ title: null, claudeProjectId: P_RADAR }, projects, [])).toEqual({ slug: 'radar', filedBy: 'claude-project' });
    expect(matchChat({ title: 'kratos', claudeProjectId: P_RADAR }, projects, [{ id: P_RADAR, projectSlug: 'kratos' }])).toEqual({ slug: 'kratos', filedBy: 'claude-project' });
    expect(matchChat({ title: 'Kratos launch plan', claudeProjectId: P_OTHER }, projects, [])).toEqual({ slug: 'kratos', filedBy: 'keyword' });
    expect(matchChat({ title: 'Kratosaurus', claudeProjectId: null }, projects, [])).toBeNull();
    expect(matchChat({ title: 'pricing', claudeProjectId: null }, projects, [])).toBeNull(); // archived
    expect(matchChat({ title: 'Meme Radar vs Kratos', claudeProjectId: null }, projects, [])?.slug).toBe('radar'); // longer keyword
    expect(matchChat({ title: 'Kratos TikTok ideas', claudeProjectId: null }, projects, [])).toBeNull(); // same length: too close to call
  });
});

describe('/ext/*: only the extension', () => {
  it('refuses web pages, other extensions, the hub page itself, GETs and non-JSON', async () => {
    const { send, ext, hubPage } = setup();
    const body = { chatId: C1, title: 'x', projectId: null };
    for (const headers of [
      { 'Content-Type': 'application/json' },
      { ...ext, Origin: 'https://claude.ai' },
      { ...ext, Origin: 'chrome-extension://otherotherotherotherotherotherot' },
      hubPage,
      { ...ext, 'Content-Type': 'text/plain' },
    ]) {
      expect((await send('/ext/chat', 'POST', headers, body)).status).toBe(403);
    }
    expect((await send('/ext/chat', 'GET', ext)).status).toBe(403);
    expect((await send('/ext/chat', 'POST', ext, { ...body, chatId: 'not-a-uuid' })).status).toBe(400);
  });

  it('keeps only id, title and project, whatever else is sent', async () => {
    const { fromExt, db } = setup();
    await fromExt('/ext/chat', { chatId: C1, title: 'Plan', projectId: null, messages: ['SECRET PROMPT TEXT'], url: 'https://claude.ai/chat/x' });
    expect(db.$client.prepare('select * from chats').all()).toEqual([
      expect.objectContaining({ id: C1, title: 'Plan', claude_project_id: null, project_slug: null, source: 'extension' }),
    ]);
    expect(JSON.stringify(db.$client.prepare('select * from chats').all())).not.toContain('SECRET');
  });
});

describe('Done when: opening a chat puts it under the right project, or the Inbox', () => {
  it('files by Claude Project, then title keyword, else the Inbox; re-files when the title or project appears', async () => {
    const { fromExt, chat } = setup();
    expect((await fromExt('/ext/chat', { chatId: C1, title: 'Notes', projectId: P_RADAR })).body).toEqual({ projectSlug: 'radar', projectName: 'Meme Radar', filedBy: 'claude-project' });
    expect((await fromExt('/ext/chat', { chatId: C2, title: null, projectId: null })).body.projectSlug).toBeNull();
    expect(await chat(C2)).toMatchObject({ projectSlug: null });
    // The title arrives a moment later and names a project keyword.
    expect((await fromExt('/ext/chat', { chatId: C2, title: 'Kratos pricing', projectId: null })).body).toMatchObject({ projectSlug: 'kratos', filedBy: 'keyword' });
    // A project link that shows up later wins over the keyword, and a later sighting without it keeps it.
    expect((await fromExt('/ext/chat', { chatId: C2, title: 'Kratos pricing', projectId: P_RADAR })).body.projectSlug).toBe('radar');
    expect((await fromExt('/ext/chat', { chatId: C2, title: 'Kratos pricing', projectId: null })).body.projectSlug).toBe('radar');
  });

  it('mapping a Claude Project on the settings page files its chats; filing by hand sticks', async () => {
    const { fromExt, call, chat } = setup();
    await fromExt('/ext/chat', { chatId: C1, title: 'Ad copy', projectId: P_OTHER });
    await fromExt('/ext/chat', { chatId: C2, title: 'Logo', projectId: P_OTHER });
    expect(await chat(C1)).toMatchObject({ projectSlug: null });
    const list = (await call('GET', '/api/claude-projects')).body;
    expect(list.claudeProjects).toEqual(
      expect.arrayContaining([
        { id: P_OTHER, name: null, projectSlug: null, yamlSlug: null, chats: 2 },
        { id: P_RADAR, name: null, projectSlug: null, yamlSlug: 'radar', chats: 0 },
      ]),
    );
    expect(list.extension).toEqual({ id: EXTENSION_ID, lastHeard: { at: expect.any(String), chatId: C2 } });

    expect((await call('PUT', `/api/chats/${C2}`, { slug: 'radar' })).body.chat).toMatchObject({ projectSlug: 'radar', filedBy: 'manual' });
    expect((await call('PUT', `/api/claude-projects/${P_OTHER}`, { slug: 'kratos' })).body).toEqual({ ok: true, moved: 1 });
    expect(await chat(C1)).toMatchObject({ projectSlug: 'kratos', filedBy: 'claude-project' });
    expect(await chat(C2)).toMatchObject({ projectSlug: 'radar', filedBy: 'manual' });
    // Back to the Inbox: automatic filing applies again.
    expect((await call('PUT', `/api/chats/${C2}`, { slug: null })).body.chat).toMatchObject({ projectSlug: 'kratos', filedBy: 'claude-project' });
    // Unmapping sends C1 back to the Inbox.
    await call('PUT', `/api/claude-projects/${P_OTHER}`, { slug: null });
    expect(await chat(C1)).toMatchObject({ projectSlug: null });
    expect((await call('PUT', '/api/claude-projects/nope', { slug: null })).status).toBe(400);
  });

  it('deleting a project returns its chats to the Inbox and clears its mappings', async () => {
    const { fromExt, call, chat } = setup();
    await call('PUT', `/api/claude-projects/${P_OTHER}`, { slug: 'kratos' });
    await fromExt('/ext/chat', { chatId: C1, title: 'x', projectId: P_OTHER });
    expect((await call('DELETE', '/api/projects/kratos')).status).toBe(200);
    expect(await chat(C1)).toMatchObject({ projectSlug: null, filedBy: null });
    expect((await call('GET', '/api/claude-projects')).body.claudeProjects.find((p: { id: string }) => p.id === P_OTHER).projectSlug).toBeNull();
  });
});

describe('the popup', () => {
  it('suggests the likely project and adds a page as a link, or files a chat by hand', async () => {
    const { fromExt, call, chat } = setup();
    await call('POST', '/api/link-rules', { slug: 'kratos', host: 'figma.com' });
    const tab = (await fromExt('/ext/tab', { url: 'https://www.figma.com/file/abc' })).body;
    expect(tab).toEqual({ kind: 'link', projects: [{ slug: 'kratos', name: 'Kratos' }, { slug: 'radar', name: 'Meme Radar' }], suggested: 'kratos', current: null });
    expect((await fromExt('/ext/link', { url: 'https://www.figma.com/file/abc', title: 'Board', slug: null })).body).toEqual({ projectSlug: 'kratos', projectName: 'Kratos' });
    expect((await call('GET', '/api/projects/kratos/links')).body[0]).toMatchObject({ title: 'Board', source: 'extension', filedBy: 'rule' });

    expect((await fromExt('/ext/tab', { url: `https://claude.ai/chat/${C1}` })).body).toMatchObject({ kind: 'chat', chatId: C1, suggested: null, current: null });
    expect((await fromExt('/ext/chat/file', { chatId: C1, title: 'Brief - Claude', slug: 'radar' })).body).toEqual({ projectSlug: 'radar', projectName: 'Meme Radar' });
    expect(await chat(C1)).toMatchObject({ title: 'Brief', filedBy: 'manual' });
    expect((await fromExt('/ext/tab', { url: `https://claude.ai/chat/${C1}` })).body).toMatchObject({ suggested: 'radar', current: 'Meme Radar' });
  });
});

describe('importing the claude.ai data export', () => {
  const conversations = [
    { uuid: C1, name: 'Meme Radar alerts', created_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-02T10:00:00Z', chat_messages: [{ text: 'SENTINEL-PROMPT-TEXT', sender: 'human' }] },
    { uuid: C2, name: 'Holiday plans', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-01T11:00:00Z', project_uuid: P_RADAR, summary: 'SENTINEL-SUMMARY', chat_messages: [] },
    { name: 'no uuid' },
  ];
  const projectsJson = [{ uuid: P_OTHER, name: 'Kratos client work', prompt_template: 'SENTINEL-TEMPLATE', docs: [{ content: 'SENTINEL-DOC' }] }];

  function zip(dir: string, files: Record<string, unknown>) {
    const src = path.join(dir, 'export');
    fs.mkdirSync(src);
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(src, name), JSON.stringify(data));
    execFileSync('/usr/bin/zip', ['-qr', path.join(dir, 'data.zip'), '.'], { cwd: src });
    return new Uint8Array(fs.readFileSync(path.join(dir, 'data.zip')));
  }

  it('reads the zip, files what it can, and keeps no message text, summaries or project documents', async () => {
    const { dir, send, hubPage, db, chat, call } = setup();
    const res = await send('/api/import/claude-export', 'POST', { ...hubPage, 'Content-Type': 'application/zip' }, zip(dir, { 'conversations.json': conversations, 'projects.json': projectsJson, 'users.json': [] }));
    expect(res).toEqual({ status: 200, body: { chats: 2, added: 2, claudeProjects: 1, skipped: 1, filed: 2, inbox: 0 } });
    expect(await chat(C1)).toMatchObject({ title: 'Meme Radar alerts', projectSlug: 'radar', filedBy: 'keyword', source: 'export', lastActiveAt: '2026-03-02T10:00:00.000Z' });
    expect(await chat(C2)).toMatchObject({ claudeProjectId: P_RADAR, projectSlug: 'radar', filedBy: 'claude-project' });
    expect((await call('GET', '/api/claude-projects')).body.claudeProjects).toEqual(expect.arrayContaining([expect.objectContaining({ id: P_OTHER, name: 'Kratos client work' })]));
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = fs.readFileSync(path.join(dir, 'hub.db')).toString('latin1');
    expect(bytes).toContain('Meme Radar alerts');
    expect(bytes).not.toMatch(/SENTINEL/);
    // The upload's temp folder is gone.
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('project-hub-import-'))).toEqual([]);
  });

  it("re-importing keeps what the extension saw; a bare conversations.json works; anything else is refused", async () => {
    const { send, hubPage, fromExt, chat } = setup();
    await fromExt('/ext/chat', { chatId: C1, title: 'Newer title from Chrome', projectId: null });
    const res = await send('/api/import/claude-export', 'POST', hubPage, JSON.stringify(conversations));
    expect(res.body).toMatchObject({ chats: 2, added: 1 });
    expect(await chat(C1)).toMatchObject({ title: 'Newer title from Chrome', source: 'extension' });
    expect((await send('/api/import/claude-export', 'POST', hubPage, '{"not":"a list"}')).status).toBe(400);
    expect((await send('/api/import/claude-export', 'POST', hubPage, 'not json')).status).toBe(400);
    expect((await send('/api/import/claude-export', 'POST', { ...hubPage, 'Content-Type': 'application/zip' }, 'not a zip')).status).toBe(400);
    // A zip upload is accepted only on this route, and only from the hub page.
    expect((await send('/api/links', 'POST', { ...hubPage, 'Content-Type': 'application/zip' }, 'x')).status).toBe(403);
    expect((await send('/api/import/claude-export', 'POST', { 'Content-Type': 'application/zip', Origin: HUB }, 'x')).status).toBe(403);
  });
});
