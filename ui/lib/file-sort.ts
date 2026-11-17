export type FileSortColumn = 'name' | 'size' | 'modified';
export interface FileSort { column: FileSortColumn; direction: 'asc' | 'desc'; }
export const DEFAULT_FILE_SORT: FileSort = { column: 'name', direction: 'asc' };

export function nextFileSort(current: FileSort, column: FileSortColumn): FileSort {
  return { column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' };
}

interface SortableEntry { name: string; is_dir: boolean; size: number; }
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Keep folders first in both directions; compare raw bytes and Unix times. */
export function sortFileEntries<T extends SortableEntry>(
  entries: readonly T[], sort: FileSort, modified: (entry: T) => number | null | undefined,
): T[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let result = 0;
    if (sort.column === 'size') result = a.size - b.size;
    if (sort.column === 'modified') {
      const av = modified(a), bv = modified(b);
      const aKnown = av != null && Number.isFinite(av);
      const bKnown = bv != null && Number.isFinite(bv);
      // Missing dates stay last in either direction.
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown) result = av! - bv!;
    }
    return direction * (result || names.compare(a.name, b.name));
  });
}
