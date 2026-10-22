// How the Toolkit section lays out a checklist. Kept apart from React so it can be tested.
type Item = { index: number; name: string; category: string; status: string; target: string | null };

export const STATUS_OPTIONS = ['not started', 'in progress', 'done', 'parked'] as const;

/** In progress first, as its own group; then each category in the order it first appears, items in file order. */
export function groupToolkit<T extends Item>(items: T[]): { title: string; inProgress: boolean; items: T[] }[] {
  const groups: { title: string; inProgress: boolean; items: T[] }[] = [];
  const inProgress = items.filter((i) => i.status === 'in progress');
  if (inProgress.length) groups.push({ title: 'In progress', inProgress: true, items: inProgress });
  const byCategory = new Map<string, T[]>();
  for (const i of items) {
    if (i.status === 'in progress') continue;
    if (!byCategory.has(i.category)) byCategory.set(i.category, []);
    byCategory.get(i.category)!.push(i);
  }
  for (const [title, list] of byCategory) groups.push({ title, inProgress: false, items: list });
  return groups;
}

/** A YYYY-MM-DD target that has passed, for an item that isn't done or parked. */
export function isOverdue(item: Pick<Item, 'target' | 'status'>, now: Date): boolean {
  if (!item.target || !/^\d{4}-\d{2}-\d{2}$/.test(item.target) || item.status === 'done' || item.status === 'parked') return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return item.target < today;
}
