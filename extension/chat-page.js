// Reads the three things the hub wants from a claude.ai chat page: the chat id
// (from the URL), its title (from the tab title) and its Claude Project (from
// the page's link to /project/<id>, when there is one). Nothing else on the
// page, and never message text. Kept apart from content.js so tests can load it.
globalThis.HubChatPage = (() => {
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const CHAT = new RegExp(`^/chat/(${UUID})(?:/|$)`, 'i');
  const PROJECT = new RegExp(`^/project/(${UUID})(?:/|$)`, 'i');

  /** The chat id in a claude.ai path, or null on any other page. */
  const chatId = (pathname) => pathname.match(CHAT)?.[1].toLowerCase() ?? null;

  /** "My chat - Claude" -> "My chat"; claude.ai's placeholders mean no title yet. */
  function title(docTitle) {
    const t = (docTitle || '').replace(/\s+[-–—|]\s+Claude\s*$/, '').trim();
    return t && !/^(claude|new chat|untitled)$/i.test(t) ? t.slice(0, 500) : null;
  }

  /**
   * The Claude Project of the open chat: the /project/<id> link on the page,
   * outside the sidebar (which can list other projects). If several different
   * projects are linked, it can't tell which, so null.
   */
  function projectId(doc) {
    const ids = new Set();
    for (const a of doc.querySelectorAll('a[href*="/project/"]')) {
      if (a.closest('nav, aside, [role="navigation"]')) continue;
      let path;
      try {
        path = new URL(a.getAttribute('href'), 'https://claude.ai').pathname;
      } catch {
        continue;
      }
      const m = path.match(PROJECT);
      if (m) ids.add(m[1].toLowerCase());
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  /** What the hub is sent for this page, or null when it isn't a chat. */
  function read(loc, doc) {
    const id = chatId(loc.pathname);
    return id ? { chatId: id, title: title(doc.title), projectId: projectId(doc) } : null;
  }

  return { chatId, title, projectId, read };
})();
