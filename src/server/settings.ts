// Hub preferences and connectors' non-secret fields, stored as key -> JSON in
// the `settings` table. Never secrets: those go to the Keychain (secrets.ts).
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { settings } from './db/schema.ts';

export function getSetting(db: Db, key: string): unknown {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(db: Db, key: string, value: unknown, now = new Date()) {
  if (value === null || value === undefined) {
    db.delete(settings).where(eq(settings.key, key)).run();
    return;
  }
  db.insert(settings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } }).run();
}
