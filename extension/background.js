// Talks to the hub. Only this worker and the popup make requests, and only to
// http://127.0.0.1:4747 (the one host the extension may reach). The hub accepts
// them because they come from this extension's own ID.
const HUB = 'http://127.0.0.1:4747';

async function post(path, body) {
  const res = await fetch(HUB + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Project Hub answered ${res.status}`);
  return json;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the content script on claude.ai sends chats.
  if (msg?.type !== 'chat' || !sender.url?.startsWith('https://claude.ai/')) return false;
  const { chatId, title, projectId } = msg.chat ?? {};
  post('/ext/chat', { chatId, title, projectId }).then(
    () => reply({ ok: true }),
    () => reply({ ok: false }),
  );
  return true; // reply comes later
});
