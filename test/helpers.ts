import type { Db } from '../src/server/db/index.ts';
import { ChangeFeed } from '../src/server/events.ts';
import type { LaunchPlan } from '../src/server/launcher.ts';

/** The hub's own origin in tests; requests go to full URLs so the Host check sees it. */
export const HUB = 'http://127.0.0.1:4747';

/** createApp deps with a launcher that records plans instead of running them. */
export function testDeps(db: Db) {
  const launched: LaunchPlan[] = [];
  return {
    launched,
    deps: {
      db,
      webDir: '/nonexistent',
      token: 't0ken',
      feed: new ChangeFeed(),
      uiToken: 'ui-t0ken',
      origins: [HUB, 'http://localhost:4747'],
      launcher: async (plan: LaunchPlan) => void launched.push(plan),
      claudeDesktopInstalled: true,
    },
  };
}
