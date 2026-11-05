import { expect, it } from 'vitest';
import { parseSftpFavorites, sftpFavoritesKey } from './sftp-favorites';

it('keeps remote paths case-sensitive and deduplicates trailing slashes including root', () => {
  expect(parseSftpFavorites(JSON.stringify([
    { name: 'Root', path: '/' }, { name: 'Duplicate root', path: '///' },
    { name: ' 작업 ', path: '/Work/' }, { name: 'Duplicate', path: '/Work' },
    { name: 'Other', path: '/work' },
  ]))).toEqual([
    { name: 'Root', path: '/' }, { name: '작업', path: '/Work' }, { name: 'Other', path: '/work' },
  ]);
});

it('ignores corrupt storage and invalid entries and limits saved bookmarks', () => {
  for (const raw of ['broken', '{}', 'null']) expect(parseSftpFavorites(raw)).toEqual([]);
  expect(parseSftpFavorites(JSON.stringify([
    null, { path: 'relative', name: 'Bad' }, { path: '/bad\npath', name: 'Bad' },
    { path: '/ok', name: ' ' }, { path: 5, name: 'Bad' },
  ]))).toEqual([]);
  expect(parseSftpFavorites(JSON.stringify(Array.from({ length: 105 }, (_, i) => ({ name: `${i}`, path: `/${i}` }))))).toHaveLength(100);
});

it('shares bookmarks across reconnects and separates hosts, ports, accounts and protocols', () => {
  const session = { session_kind: 'ssh' as const, host: 'Server', port: 22, username: 'alice' };
  const key = sftpFavoritesKey(session);
  expect(sftpFavoritesKey({ ...session, host: 'server' })).toBe(key);
  for (const other of [
    { ...session, host: 'other' }, { ...session, port: 2222 },
    { ...session, username: 'Alice' }, { ...session, session_kind: 'wsl' as const },
  ]) expect(sftpFavoritesKey(other)).not.toBe(key);
});
