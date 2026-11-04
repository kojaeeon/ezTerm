import { expect, it } from 'vitest';
import { folderKey, parseFileBrowserPrefs } from './file-browser-prefs';

it('restores home and bookmark names while deduplicating Windows paths', () => {
  const prefs = parseFileBrowserPrefs(JSON.stringify({ home: 'D:\\작업', favorites: [
    { name: ' 작업 ', path: 'D:\\Work\\' }, { name: 'Duplicate', path: 'd:/work' },
    { name: '네트워크', path: '\\\\server\\share' }, { name: '', path: 'C:\\' }, null,
  ] }));
  expect(prefs.home).toBe('D:\\작업');
  expect(prefs.favorites.map((item) => item.name)).toEqual(['작업', '네트워크']);
  expect(folderKey('D:/Work/')).toBe(folderKey('d:\\work'));
});

it('recovers from malformed or unavailable storage data', () => {
  for (const raw of [null, '{invalid', 'null', '42']) {
    expect(parseFileBrowserPrefs(raw)).toEqual({ home: '', favorites: [] });
  }
});
