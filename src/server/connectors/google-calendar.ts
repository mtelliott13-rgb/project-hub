// Calendar backends: the real one over the Google connector, and a local
// stand-in for `pnpm sample` that makes no requests at all.
import crypto from 'node:crypto';
import { CALENDAR_API, type GoogleConnector } from './google.ts';
import type { ConnectorRegistry } from './registry.ts';
import { AuthRejected, ConnectorError } from './types.ts';
import { googleEventSchema, googleFailure, type CalendarBackend, type GoogleEvent } from '../calendar.ts';
import { z } from 'zod';

const listSchema = z.object({ summary: z.string().optional(), nextPageToken: z.string().optional(), items: z.array(z.unknown()).optional() });
const FIELDS = 'summary,nextPageToken,items(id,status,summary,htmlLink,start,end,recurringEventId,extendedProperties/private)';
const MAX_PAGES = 10;

export function googleCalendarBackend(registry: ConnectorRegistry, g: GoogleConnector): CalendarBackend {
  const ctx = () => registry.context(g.id);
  /** A call that, if Google rejects the sign-in, marks the connector so the page shows Reconnect. */
  const guarded = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AuthRejected) await registry.markNeedsReconnect(g.id, e);
      throw e;
    }
  };
  const events = `${CALENDAR_API}/calendars/primary/events`;
  return {
    ready: () => registry.isActive(g.id),
    async list(timeMin, timeMax, timeZone) {
      const items: GoogleEvent[] = [];
      let account: string | null = null;
      let page: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const q = new URLSearchParams({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
          timeZone,
          fields: FIELDS,
          ...(page ? { pageToken: page } : {}),
        });
        const res = await g.api(ctx(), `${events}?${q}`);
        if (!res.ok) throw await googleFailure(res, 'reading your calendar');
        const body = listSchema.parse(await res.json());
        // For the primary calendar, its summary is the account's address.
        account = body.summary ?? account;
        for (const raw of body.items ?? []) {
          const e = googleEventSchema.safeParse(raw);
          if (e.success) items.push(e.data);
        }
        page = body.nextPageToken;
        if (!page) break;
      }
      return { account, items };
    },
    insert: (body) =>
      guarded(async () => {
        const res = await g.api(ctx(), `${events}?fields=id,status,summary,htmlLink,start,end,recurringEventId,extendedProperties`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw await googleFailure(res, 'adding the event');
        const e = googleEventSchema.safeParse(await res.json());
        if (!e.success) throw new ConnectorError('bad-answer', 'Google sent back something unexpected.');
        return e.data;
      }),
    delete: (id) =>
      guarded(async () => {
        const res = await g.api(ctx(), `${events}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        // Already gone counts as deleted.
        if (!res.ok && res.status !== 404 && res.status !== 410) throw await googleFailure(res, 'deleting the event');
      }),
  };
}

/** `pnpm sample`: events are added to the local cache only, never sent anywhere. */
export function sampleCalendarBackend(): CalendarBackend {
  return {
    ready: () => true,
    list: async () => ({ account: null, items: [] }),
    insert: async (body) => ({
      id: `sample${crypto.randomBytes(8).toString('hex')}`,
      summary: body.summary,
      start: body.start,
      end: body.end,
      recurringEventId: body.recurrence ? 'sample-series' : undefined,
      extendedProperties: { private: body.extendedProperties.private },
    }),
    delete: async () => {},
  };
}
