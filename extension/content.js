// Runs on claude.ai pages. Once a second it reads the open chat's id, title and
// Claude Project (chat-page.js) and, when any of them changed, hands them to
// the extension's background worker to send to the hub. claude.ai changes
// pages without reloading, so the URL is re-read each time too.
(() => {
  let sent = null; // JSON of what the hub last accepted
  let retryAt = 0; // after a failure (hub not running), wait before trying again

  function tick() {
    const now = globalThis.HubChatPage.read(location, document);
    if (!now) return;
    const json = JSON.stringify(now);
    if (json === sent || Date.now() < retryAt) return;
    try {
      chrome.runtime.sendMessage({ type: 'chat', chat: now }, (reply) => {
        if (chrome.runtime.lastError || !reply?.ok) retryAt = Date.now() + 15000;
        else sent = json;
      });
    } catch {
      // The extension was reloaded or removed: this copy of the script is orphaned.
      clearInterval(timer);
    }
  }

  const timer = setInterval(tick, 1000);
  tick();
})();
