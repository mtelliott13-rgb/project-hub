// The toolbar popup: adds the current tab to a project. Chrome lets it read the
// tab's address and title only because you clicked the button (activeTab).
const HUB = 'http://127.0.0.1:4747';
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const res = await fetch(HUB + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Project Hub answered ${res.status}`);
  return json;
}

const say = (text, error) => {
  $('note').textContent = text;
  $('note').className = error ? 'note error' : 'note';
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return say('Only web pages (http or https) can be added.', true);
  $('title').textContent = tab.title || tab.url;
  $('url').textContent = tab.url;
  let info;
  try {
    info = await post('/ext/tab', { url: tab.url });
  } catch (e) {
    return say(e instanceof TypeError ? "Can't reach Project Hub at 127.0.0.1:4747. Is it running?" : e.message, true);
  }
  const select = $('project');
  select.add(new Option(info.kind === 'chat' ? 'Inbox (let its Claude Project or keywords decide)' : 'Inbox (let the rules decide)', ''));
  for (const p of info.projects) select.add(new Option(p.name, p.slug));
  select.value = info.suggested ?? '';
  if (info.current) say(`Now in: ${info.current}`);
  $('add').disabled = false;
  $('add').onclick = async () => {
    $('add').disabled = true;
    try {
      const slug = select.value || null;
      const out =
        info.kind === 'chat'
          ? await post('/ext/chat/file', { chatId: info.chatId, title: tab.title ?? null, slug })
          : await post('/ext/link', { url: tab.url, title: tab.title ?? null, slug });
      say(out.projectName ? `Added to ${out.projectName}.` : 'Added to the Inbox.');
    } catch (e) {
      say(e.message, true);
      $('add').disabled = false;
    }
  };
})();
