// Settings → Connections. Every route is under /api/*, so the app-wide check
// (hubPageRefusal in app.ts) already requires the hub's own Origin, JSON and the
// page token; the writes here also refuse a missing Origin explicitly, so they
// stay protected even if they move. Answers carry status only, never a secret.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ConnectorRegistry } from './registry.ts';
import { ConnectorError } from './types.ts';

/** Where Connect may send you back to after a sign-in: the hub's own pages only. */
export const RETURN_PAGES = ['/settings#connections', '/today', '/'];
const connectBody = z.object({ returnTo: z.enum(RETURN_PAGES as [string, ...string[]]).optional() }).strict();

const fieldsBody = z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.string().max(4096));

export function addConnectorRoutes(app: Hono, registry: ConnectorRegistry, origins: string[]) {
  const ownOrigin = (c: Context) => {
    const o = c.req.header('Origin');
    return o !== undefined && origins.includes(o);
  };
  const known = (id: string) => registry.ids().includes(id);
  const fail = (c: Context, e: unknown) => {
    if (e instanceof ConnectorError) return c.json({ error: e.message, code: e.code }, e.code === 'unknown' ? 404 : 400);
    // Never pass an unexpected error's text to the page.
    return c.json({ error: 'Something went wrong; see the hub log.' }, 500);
  };
  const write = (handler: (c: Context, id: string) => Promise<Response>) => async (c: Context) => {
    if (!ownOrigin(c)) return c.json({ error: 'requests must come from the hub page (Origin)' }, 403);
    const id = c.req.param('id') ?? '';
    if (!known(id)) return c.json({ error: `No connector called "${id}"` }, 404);
    try {
      return await handler(c, id);
    } catch (e) {
      return fail(c, e);
    }
  };

  app.use('/api/connectors/*', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Too large' }, 413) }));

  app.get('/api/connectors', async (c) => c.json(await registry.statuses()));

  app.put(
    '/api/connectors/:id/fields',
    write(async (c, id) => {
      const parsed = fieldsBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Expected { field: "value" }' }, 400);
      return c.json(await registry.saveFields(id, parsed.data));
    }),
  );

  app.delete(
    '/api/connectors/:id/fields/:key',
    write(async (c, id) => c.json(await registry.removeField(id, c.req.param('key') ?? ''))),
  );

  app.post(
    '/api/connectors/:id/connect',
    write(async (c, id) => {
      const parsed = connectBody.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'Unknown page to return to' }, 400);
      return c.json(await registry.connect(id, parsed.data));
    }),
  );

  // A credentials file (e.g. Google's client JSON), read on the server and
  // reduced to the connector's fields; the rest of the file is never kept.
  app.post(
    '/api/connectors/:id/import',
    write(async (c, id) => {
      const json = await c.req.json().catch(() => null);
      if (json === null) return c.json({ error: "That file isn't JSON." }, 400);
      return c.json(await registry.importFile(id, json));
    }),
  );

  // OAuth: the service sends the browser back here with ?code&state. This is a
  // top-level navigation from the service's site, so it can't carry the page
  // token or the hub's Origin; the one-time state value (and PKCE) protect it
  // instead, and the app-wide Host check still applies. It only ever redirects
  // to one of the hub's own pages.
  app.get('/oauth/:id/callback', async (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.text('Unknown connector', 404);
    const { returnTo, error } = await registry.finishCallback(id, new URL(c.req.url).searchParams);
    const page = RETURN_PAGES.includes(returnTo) ? returnTo : '/settings#connections';
    const [pathPart, hash = ''] = page.split('#');
    const target = `${pathPart}?connected=${encodeURIComponent(id)}&ok=${error ? '0' : '1'}${hash ? `#${hash}` : ''}`;
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(target, 302);
  });

  app.post(
    '/api/connectors/:id/disconnect',
    write(async (c, id) => c.json({ status: await registry.disconnect(id) })),
  );

  app.post(
    '/api/connectors/:id/sync',
    write(async (c, id) => {
      if (!registry.isActive(id)) return c.json({ error: 'Connect it first', code: 'not-connected' }, 409);
      return c.json({ status: await registry.sync(id) });
    }),
  );
}
