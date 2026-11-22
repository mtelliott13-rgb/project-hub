// v4 redesign: the page's pure display rules (project colours, idle sessions,
// constellation placement).
import { describe, expect, it } from 'vitest';
import { assignProjectColors, dayPart, idleDays, initials, isIdle, PROJECT_PALETTE, projectColor, runningCounts, runningLabel, sessionTag, slugAngle, spreadAngles } from '../web/src/colors.ts';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('projectColor', () => {
  it('is stable per slug and one of the eight slots', () => {
    for (const slug of ['career-hq', 'land-cover', 'project-hub', 'market-data']) {
      expect(projectColor(slug)).toBe(projectColor(slug));
      expect(PROJECT_PALETTE).toContain(projectColor(slug));
    }
  });

  it("doesn't depend on which other projects exist", () => {
    const before = ['a', 'b', 'c'].map(projectColor);
    ['z', 'y'].map(projectColor);
    expect(['a', 'b', 'c'].map(projectColor)).toEqual(before);
  });

  it('uses several slots across slugs', () => {
    const used = new Set(Array.from({ length: 40 }, (_, i) => projectColor(`project-${i}`)));
    expect(used.size).toBeGreaterThan(4);
  });
});

describe('assignProjectColors', () => {
  it('gives colliding projects different slots, oldest keeps its own', () => {
    const slugs = Array.from({ length: 8 }, (_, i) => `p${i}`);
    assignProjectColors(slugs.map((slug, i) => ({ slug, createdAt: `2026-01-0${i + 1}` })));
    expect(new Set(slugs.map(projectColor)).size).toBe(8);
  });

  it('adding a project never recolours an existing one', () => {
    const base = ['alpha', 'beta', 'gamma'].map((slug, i) => ({ slug, createdAt: `2026-01-0${i + 1}` }));
    assignProjectColors(base);
    const before = base.map((p) => projectColor(p.slug));
    assignProjectColors([...base, { slug: 'delta', createdAt: '2026-02-01' }, { slug: 'eps', createdAt: '2026-02-02' }]);
    expect(base.map((p) => projectColor(p.slug))).toEqual(before);
  });
});

describe('initials', () => {
  it('takes two words or the first two letters', () => {
    expect(initials('Career HQ')).toBe('CH');
    expect(initials('Project Hub')).toBe('PH');
    expect(initials('acme-site')).toBe('AS');
    expect(initials('hub')).toBe('HU');
    expect(initials('  ')).toBe('?');
  });
});

describe('idle sessions', () => {
  it('is idle only when running and last active over 24 hours ago', () => {
    expect(isIdle({ state: 'running', lastActiveAt: hoursAgo(23) }, NOW)).toBe(false);
    expect(isIdle({ state: 'running', lastActiveAt: hoursAgo(25) }, NOW)).toBe(true);
    expect(isIdle({ state: 'ended', lastActiveAt: hoursAgo(100) }, NOW)).toBe(false);
  });

  it('tags sessions', () => {
    expect(sessionTag({ state: 'running', lastActiveAt: hoursAgo(1) }, NOW)).toBe('Running');
    expect(sessionTag({ state: 'running', lastActiveAt: hoursAgo(26) }, NOW)).toBe('Running · idle 1d');
    expect(sessionTag({ state: 'running', lastActiveAt: hoursAgo(80) }, NOW)).toBe('Running · idle 3d');
    expect(sessionTag({ state: 'ended', lastActiveAt: hoursAgo(1) }, NOW)).toBe('Ended');
    expect(idleDays({ state: 'running', lastActiveAt: hoursAgo(49) }, NOW)).toBe(2);
  });

  it('counts running and idle', () => {
    const c = runningCounts(
      [
        { state: 'running', lastActiveAt: hoursAgo(1) },
        { state: 'running', lastActiveAt: hoursAgo(30) },
        { state: 'ended', lastActiveAt: hoursAgo(1) },
      ],
      NOW,
    );
    expect(c).toEqual({ running: 2, idle: 1 });
    expect(runningLabel(c)).toBe('2 running (1 idle)');
    expect(runningLabel({ running: 3, idle: 0 })).toBe('3 running');
  });
});

describe('dayPart', () => {
  it('buckets the hour', () => {
    expect([6, 13, 19, 23, 2].map(dayPart)).toEqual(['morning', 'afternoon', 'evening', 'night', 'night']);
  });
});

describe('constellation angles', () => {
  it('gives each slug a stable angle', () => {
    expect(slugAngle('career-hq')).toBe(slugAngle('career-hq'));
    expect(slugAngle('career-hq')).toBeGreaterThanOrEqual(0);
    expect(slugAngle('career-hq')).toBeLessThan(360);
  });

  it('spreads close angles apart and keeps far ones', () => {
    const out = spreadAngles([10, 12, 200], 30);
    const gap = Math.abs(out[1] - out[0]);
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(29.99);
    expect(out[2]).toBe(200);
  });

  it('handles wrap-around and crowded rings', () => {
    const out = spreadAngles([355, 2, 5, 8], 40);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
      expect(next - sorted[i]).toBeGreaterThanOrEqual(39.99);
    }
  });
});
