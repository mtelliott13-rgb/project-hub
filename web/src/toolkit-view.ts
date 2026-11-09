// How the Toolkit section lays out a checklist. Kept apart from React so it can be tested.
type Item = {
  index: number;
  name: string;
  category: string;
  status: string;
  target: string | null;
  hours: number | 'ongoing' | null;
  priority: 'high' | 'medium' | 'low' | null;
};

export const STATUS_OPTIONS = ['not started', 'in progress', 'done', 'parked'] as const;

export type ToolkitSort = 'hours' | 'priority';
export const SORTS: { id: ToolkitSort; label: string }[] = [
  { id: 'hours', label: 'Fastest first' },
  { id: 'priority', label: 'Priority' },
];

/** Numbers low to high, then `ongoing`, then blank (or unreadable). */
const hoursRank = (h: Item['hours']) => (typeof h === 'number' ? h : h === 'ongoing' ? Number.MAX_VALUE : Infinity);
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const priorityRank = (p: Item['priority']) => (p ? PRIORITY_RANK[p] : 3);

function compare(sort: ToolkitSort) {
  return (a: Item, b: Item) => {
    // Two blanks give Infinity - Infinity = NaN; `|| 0` makes that a tie.
    const h = hoursRank(a.hours) - hoursRank(b.hours) || 0;
    const p = priorityRank(a.priority) - priorityRank(b.priority);
    return (sort === 'priority' ? p || h : h) || a.index - b.index;
  };
}

export type ToolkitGroup<T> = { title: string; status: 'in progress' | 'to do' | 'done' | 'parked'; items: T[] };

/**
 * In progress first, as its own group; then everything still to do; then done,
 * then parked. Each group is sorted fastest first (blank and `ongoing` hours
 * last) or by priority (ties fastest first), then file order. Empty groups are left out.
 */
export function arrangeToolkit<T extends Item>(items: T[], sort: ToolkitSort = 'hours'): ToolkitGroup<T>[] {
  const groups: ToolkitGroup<T>[] = [
    { title: 'In progress', status: 'in progress', items: items.filter((i) => i.status === 'in progress') },
    { title: 'To do', status: 'to do', items: items.filter((i) => !['in progress', 'done', 'parked'].includes(i.status)) },
    { title: 'Done', status: 'done', items: items.filter((i) => i.status === 'done') },
    { title: 'Parked', status: 'parked', items: items.filter((i) => i.status === 'parked') },
  ];
  const cmp = compare(sort);
  return groups.filter((g) => g.items.length).map((g) => ({ ...g, items: [...g.items].sort(cmp) }));
}

/** "30 min" under an hour, else "10 h" (decimals kept: "3.1 h"), or "ongoing". */
export function formatHours(h: Item['hours']): string | null {
  if (h === null) return null;
  if (h === 'ongoing') return 'ongoing';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${Number.isInteger(h) ? h : Number(h.toFixed(2))} h`;
}

/** A YYYY-MM-DD target that has passed, for an item that isn't done or parked. */
export function isOverdue(item: Pick<Item, 'target' | 'status'>, now: Date): boolean {
  if (!item.target || !/^\d{4}-\d{2}-\d{2}$/.test(item.target) || item.status === 'done' || item.status === 'parked') return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return item.target < today;
}
