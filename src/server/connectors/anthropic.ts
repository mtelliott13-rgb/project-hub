// The Anthropic API connector: holds your API key for quick-add's "Anthropic
// API" parser. Connect checks the key once (GET /v1/models, which costs
// nothing); after that the key is used only when you add a reminder with that
// parser chosen. Plain fetch, no SDK.
import { AuthRejected, ConnectorError, type Connector } from './types.ts';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicConnector: Connector = {
  id: 'anthropic',
  name: 'Anthropic API',
  description: "Lets quick-add use Claude through your own API key instead of Claude Code. Only needed if you choose the Anthropic API parser.",
  sends:
    'Connect sends your key to api.anthropic.com once to check it. After that, only when you add a reminder with the Anthropic API parser chosen: the reminder text, today\'s date and time, your time zone and your project names and slugs.',
  fields: [
    {
      key: 'api-key',
      label: 'API key',
      secret: true,
      help: 'From console.anthropic.com → API keys. Stored in the macOS Keychain.',
      check: (v) => (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v) ? null : 'That doesn\'t look like an Anthropic API key (they start with "sk-ant-").'),
    },
  ],
  required: ['api-key'],
  async connect(ctx) {
    const key = await ctx.secrets.get('api-key');
    if (!key) throw new ConnectorError('not-ready', 'Save the API key first');
    const res = await ctx.fetch(`${ANTHROPIC_API}/v1/models?limit=1`, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw new AuthRejected('Anthropic rejected that API key. Replace it and connect again.');
    if (!res.ok) throw new ConnectorError('http', `Anthropic answered ${res.status}. Try again in a minute.`);
    return { kind: 'connected', account: 'API key' };
  },
  async disconnect() {
    // The key stays saved (Remove forgets it); disconnected, it's never used.
  },
};
