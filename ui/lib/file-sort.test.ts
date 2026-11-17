import { describe, expect, it } from 'vitest';
import { DEFAULT_FILE_SORT, nextFileSort, sortFileEntries } from './file-sort';

const entries = [
  { name: 'file10', is_dir: false, size: 10, modified: 100 },
  { name: 'folder', is_dir: true, size: 0, modified: 50 },
  { name: 'file2', is_dir: false, size: 2048, modified: 200 },
  { name: 'unknown', is_dir: false, size: 100, modified: null },
];
const sort = (column: 'name' | 'size' | 'modified', direction: 'asc' | 'desc') =>
  sortFileEntries(entries, { column, direction }, (entry) => entry.modified).map((entry) => entry.name);

describe('file list sorting', () => {
  it('toggles direction and starts a different column ascending', () => {
    const descending = nextFileSort(DEFAULT_FILE_SORT, 'name');
    expect(descending.direction).toBe('desc');
    expect(nextFileSort(descending, 'name')).toEqual(DEFAULT_FILE_SORT);
    expect(nextFileSort(descending, 'size')).toEqual({ column: 'size', direction: 'asc' });
  });
  it('sorts names naturally and keeps folders first in either direction', () => {
    expect(sort('name', 'asc')).toEqual(['folder', 'file2', 'file10', 'unknown']);
    expect(sort('name', 'desc')).toEqual(['folder', 'unknown', 'file10', 'file2']);
  });
  it('compares byte sizes rather than formatted labels', () => {
    expect(sort('size', 'asc')).toEqual(['folder', 'file10', 'unknown', 'file2']);
    expect(sort('size', 'desc')).toEqual(['folder', 'file2', 'unknown', 'file10']);
  });
  it('compares timestamps and keeps unknown dates last', () => {
    expect(sort('modified', 'asc')).toEqual(['folder', 'file10', 'file2', 'unknown']);
    expect(sort('modified', 'desc')).toEqual(['folder', 'file2', 'file10', 'unknown']);
  });
  it('preserves the input list and entry objects used for selection', () => {
    const result = sortFileEntries(entries, DEFAULT_FILE_SORT, (entry) => entry.modified);
    expect(entries[0].name).toBe('file10');
    expect(result[0]).toBe(entries[1]);
  });
});
