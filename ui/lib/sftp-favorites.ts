import type { Session } from './types';

export interface SftpFavorite { name: string; path: string; }
export const SFTP_FAVORITES_CHANGED = 'ezterm:sftp-favorites-changed';

export function sftpFavoritesKey(session: Pick<Session, 'session_kind' | 'host' | 'port' | 'username'>): string {
  return `ezterm.sftpFavorites.${JSON.stringify([
    session.session_kind,
    session.session_kind === 'ssh' ? session.host.toLowerCase() : session.host,
    session.session_kind === 'ssh' ? session.port : null,
    session.username,
  ])}`;
}

// Remote paths are case-sensitive. Only trailing separators are equivalent.
export const remoteFolderKey = (path: string) => path.replace(/\/+$/, '') || '/';

export function parseSftpFavorites(raw: string | null): SftpFavorite[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!Array.isArray(parsed)) return [];
    const favorites: SftpFavorite[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item.path !== 'string' || !item.path.startsWith('/')
        || /[\x00-\x1f\x7f]/.test(item.path)
        || typeof item.name !== 'string' || !item.name.trim()) continue;
      const path = remoteFolderKey(item.path);
      if (seen.has(path)) continue;
      seen.add(path);
      favorites.push({ path, name: item.name.trim().slice(0, 100) });
      if (favorites.length === 100) break;
    }
    return favorites;
  } catch { return []; }
}
