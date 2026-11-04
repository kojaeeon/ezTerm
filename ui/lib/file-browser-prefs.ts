export interface FavoriteFolder { name: string; path: string; }
export interface FileBrowserPrefs { home: string; favorites: FavoriteFolder[]; }
export const FILE_BROWSER_PREFS_KEY = 'ezterm.fileBrowserPrefs';
export const folderKey = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function parseFileBrowserPrefs(raw: string | null): FileBrowserPrefs {
  const defaults: FileBrowserPrefs = { home: '', favorites: [] };
  try {
    const parsed = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object') return defaults;
    const home = typeof parsed.home === 'string' ? parsed.home : '';
    const favorites: FavoriteFolder[] = [];
    const seen = new Set<string>();
    if (Array.isArray(parsed.favorites)) for (const item of parsed.favorites.slice(0, 100)) {
      if (!item || typeof item.path !== 'string' || !item.path.trim()
        || typeof item.name !== 'string' || !item.name.trim()) continue;
      const key = folderKey(item.path);
      if (seen.has(key)) continue;
      seen.add(key);
      favorites.push({ name: item.name.trim().slice(0, 100), path: item.path });
    }
    return { home, favorites };
  } catch { return defaults; }
}

export function readFileBrowserPrefs(): FileBrowserPrefs {
  if (typeof window === 'undefined') return parseFileBrowserPrefs(null);
  try { return parseFileBrowserPrefs(localStorage.getItem(FILE_BROWSER_PREFS_KEY)); }
  catch { return parseFileBrowserPrefs(null); }
}
