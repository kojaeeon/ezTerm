'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Copy, Folder, FolderOpen, HardDrive, Home, Loader2, RefreshCw, Star, X } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open } from '@tauri-apps/plugin-dialog';
import { api, errMessage, type LocalListing, type LocalEntry } from '@/lib/tauri';
import { ResizeHandle } from './resize-handle';
import { beginPointerDrag } from '@/lib/pointer-drag';
import { LOCAL_FILE_DROP, type LocalFileDrop } from '@/lib/local-file-drop';
import { toast } from '@/lib/toast';
import { ContextMenu, type MenuItem } from './context-menu';
import { PromptDialog } from './prompt-dialog';
import { LocalFileIcon } from './local-file-icon';
import { FILE_BROWSER_PREFS_KEY, folderKey, readFileBrowserPrefs, type FileBrowserPrefs, type FavoriteFolder } from '@/lib/file-browser-prefs';

const PATH_KEY = 'ezterm.localFilesPath';

function sizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export function LocalFilesPane({ onClose }: { onClose: () => void }) {
  const [listing, setListing] = useState<LocalListing | null>(null);
  const [address, setAddress] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(360);
  const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 });
  const sequence = useRef(0);
  const dragCancel = useRef<(() => void) | undefined>(undefined);
  const [draggingFile, setDraggingFile] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: LocalEntry } | null>(null);
  const [preferences, setPreferences] = useState(readFileBrowserPrefs);
  const [popupMenu, setPopupMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renameFavorite, setRenameFavorite] = useState<FavoriteFolder | null>(null);
  const cancelDrag = useCallback(() => { dragCancel.current?.(); }, []);
  const cancelNavigation = useCallback(() => { sequence.current++; }, []);

  function savePreferences(next: FileBrowserPrefs) {
    setPreferences(next);
    try { localStorage.setItem(FILE_BROWSER_PREFS_KEY, JSON.stringify(next)); }
    catch { toast.danger('설정 저장 실패', '저장 공간을 사용할 수 없습니다. 이번 실행에만 적용됩니다.'); }
  }
  function toggleFavorite(path: string) {
    const key = folderKey(path);
    const existing = preferences.favorites.some((item) => folderKey(item.path) === key);
    if (!existing && preferences.favorites.length >= 100) {
      toast.info('즐겨찾기', '즐겨찾기는 최대 100개까지 저장할 수 있습니다.'); return;
    }
    savePreferences({ ...preferences, favorites: existing
      ? preferences.favorites.filter((item) => folderKey(item.path) !== key)
      : [...preferences.favorites, { path, name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path }] });
  }
  async function changeHome(path?: string) {
    try {
      const chosen = path ?? await open({ directory: true, multiple: false, defaultPath: preferences.home || listing?.path });
      if (typeof chosen !== 'string') return;
      const verified = await api.localFilesList(chosen);
      savePreferences({ ...preferences, home: verified.path });
      toast.success('홈 폴더 변경', verified.path);
    } catch (e) { toast.danger('홈 폴더 변경 실패', errMessage(e)); }
  }
  function showMenu(x: number, y: number, items: MenuItem[]) {
    setContextMenu(null);
    setPopupMenu({ x: Math.max(0, Math.min(x, window.innerWidth - 250)), y: Math.max(0, Math.min(y, window.innerHeight - items.length * 30 - 16)), items });
  }
  function folderMenu(path: string): MenuItem[] {
    return [
      { label: '파일 탐색기 열기', onClick: () => { void api.localFilesExplorer(path).catch((e) => toast.danger('탐색기 열기 실패', errMessage(e))); } },
      { label: '이 폴더를 홈으로 설정', onClick: () => { void changeHome(path); } },
      { label: preferences.favorites.some((item) => folderKey(item.path) === folderKey(path)) ? '즐겨찾기에서 제거' : '즐겨찾기에 추가', onClick: () => toggleFavorite(path) },
    ];
  }
  function showHomeMenu(x: number, y: number) {
    showMenu(x, y, [
      { label: '홈 폴더 변경…', onClick: () => { void changeHome(); } },
      { label: '현재 폴더를 홈으로 설정', disabled: !listing, onClick: () => { if (listing) void changeHome(listing.path); } },
      { label: '기본 사용자 홈으로 복원', onClick: () => savePreferences({ ...preferences, home: '' }) },
    ]);
  }

  const navigate = useCallback(async (path: string, index?: number, refresh = false) => {
    const request = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.localFilesList(path);
      if (request !== sequence.current) return;
      setListing(result);
      setAddress(result.path);
      setSelected(null);
      if (!refresh) setFilter('');
      setHistory((previous) => {
        if (refresh) return previous;
        if (index !== undefined) return { ...previous, index };
        if (previous.paths[previous.index] === result.path) return previous;
        const paths = [...previous.paths.slice(0, previous.index + 1), result.path];
        return { paths, index: paths.length - 1 };
      });
      try { localStorage.setItem(PATH_KEY, result.path); } catch { /* storage unavailable */ }
    } catch (e) {
      if (request === sequence.current) setError(errMessage(e));
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let initial = readFileBrowserPrefs().home;
    try { initial = localStorage.getItem(PATH_KEY) ?? initial; } catch { /* storage unavailable */ }
    const timer = window.setTimeout(() => { void navigate(initial); }, 0);
    let disposed = false;
    api.localFilesRoots().then((items) => { if (!disposed) setRoots(items); })
      .catch(() => { /* Home and address navigation remain available. */ });
    return () => { disposed = true; window.clearTimeout(timer); cancelNavigation(); cancelDrag(); };
  }, [navigate, cancelNavigation, cancelDrag]);

  useEffect(() => {
    const refresh = () => { if (listing) void navigate(listing.path, undefined, true); };
    window.addEventListener('ezterm:local-files-changed', refresh);
    return () => window.removeEventListener('ezterm:local-files-changed', refresh);
  }, [listing, navigate]);

  async function openEntry(entry: LocalEntry) {
    if (entry.is_dir) { await navigate(entry.path); return; }
    try { await api.localFilesOpen(entry.path); }
    catch (e) { toast.danger('Could not open file', errMessage(e)); }
  }

  async function chooseFolder() {
    try {
      const path = await open({ directory: true, multiple: false, defaultPath: listing?.path });
      if (typeof path === 'string') await navigate(path);
    } catch (e) { setError(errMessage(e)); }
  }

  async function copyPath() {
    const path = selected ?? listing?.path;
    if (!path) return;
    try { await writeText(path); } catch (e) { setError(errMessage(e)); }
  }

  const entries = listing?.entries.filter((entry) => (hidden || !entry.hidden)
    && entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const selectedEntry = listing?.entries.find((entry) => entry.path === selected);

  return (
    <aside aria-label="Local file explorer" className="relative shrink-0 min-h-0 flex flex-col border-r border-border bg-surface text-fg" style={{ width, maxWidth: '60vw' }} onContextMenu={(event) => {
      if (event.defaultPrevented || !listing) return;
      if ((event.target as HTMLElement).closest('input, textarea, [role="menu"]')) return;
      event.preventDefault();
      showMenu(event.clientX, event.clientY, folderMenu(listing.path));
    }}>
      <header className="h-9 px-2 flex items-center gap-2 border-b border-border shrink-0">
        <HardDrive size={14} className="text-accent" />
        <span className="text-xs font-semibold flex-1">Local files</span>
        <button type="button" className="icon-btn" title="Choose folder" aria-label="Choose local folder" onClick={chooseFolder}><FolderOpen size={14} /></button>
        <button type="button" className="icon-btn" title="Copy selected path" aria-label="Copy selected path" disabled={!listing} onClick={copyPath}><Copy size={13} /></button>
        <button type="button" className="icon-btn" title="Close local files" aria-label="Close local files" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <button type="button" className="icon-btn" title="Back" aria-label="Back" disabled={busy || history.index <= 0} onClick={() => navigate(history.paths[history.index - 1], history.index - 1)}><ArrowLeft size={14} /></button>
        <button type="button" className="icon-btn" title="Forward" aria-label="Forward" disabled={busy || history.index >= history.paths.length - 1} onClick={() => navigate(history.paths[history.index + 1], history.index + 1)}><ArrowRight size={14} /></button>
        <button type="button" className="icon-btn" title="Up one folder" aria-label="Up one folder" disabled={busy || !listing?.parent} onClick={() => listing?.parent && navigate(listing.parent)}><ArrowUp size={14} /></button>
        <button type="button" className="icon-btn" title={`홈 폴더: ${preferences.home || '기본 사용자 홈'}`} aria-label="Home folder" onClick={() => navigate(preferences.home)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); showHomeMenu(event.clientX, event.clientY); }}><Home size={14} /></button>
        <button type="button" className="icon-btn" title="홈 폴더 변경" aria-label="홈 폴더 변경" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); showHomeMenu(rect.left, rect.bottom); }}><ChevronDown size={11} /></button>
        <button type="button" className="icon-btn" title="Refresh local files" aria-label="Refresh local files" disabled={busy || !listing} onClick={() => listing && navigate(listing.path, undefined, true)}><RefreshCw size={13} /></button>
        {busy && <Loader2 size={13} className="animate-spin ml-auto" aria-label="Loading files" />}
      </div>
      <form className="px-2 pt-2 shrink-0 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void navigate(address.trim()); }}>
        <input aria-label="Local folder path" className="min-w-0 flex-1 bg-bg border border-border rounded px-2 py-1 text-xs focus-ring" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Enter a folder path" spellCheck={false} />
        <button type="button" className="icon-btn" disabled={!listing} title="현재 폴더 즐겨찾기" aria-label="현재 폴더 즐겨찾기" aria-pressed={!!listing && preferences.favorites.some((item) => folderKey(item.path) === folderKey(listing.path))} onClick={() => { if (listing) toggleFavorite(listing.path); }}><Star size={15} className={listing && preferences.favorites.some((item) => folderKey(item.path) === folderKey(listing.path)) ? 'fill-accent text-accent' : ''} /></button>
      </form>
      <nav aria-label="즐겨찾기 폴더" className="px-2 py-1.5 flex gap-1 items-center border-b border-border overflow-x-auto shrink-0">
        {preferences.favorites.length === 0 ? <span className="text-[11px] text-muted whitespace-nowrap">☆ 주소창 옆 별표로 폴더를 즐겨찾기에 추가</span> : preferences.favorites.map((favorite, index) => (
          <button key={folderKey(favorite.path)} type="button" className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-surface2 focus-ring shrink-0 max-w-36" title={`${favorite.name}\n${favorite.path}`} onClick={() => navigate(favorite.path)} onContextMenu={(event) => {
            event.preventDefault(); event.stopPropagation();
            const move = (offset: number) => {
              const favorites = [...preferences.favorites];
              [favorites[index], favorites[index + offset]] = [favorites[index + offset], favorites[index]];
              savePreferences({ ...preferences, favorites });
            };
            showMenu(event.clientX, event.clientY, [
              { label: '폴더 열기', onClick: () => { void navigate(favorite.path); } },
              { label: '이름 변경…', onClick: () => setRenameFavorite(favorite) },
              { label: '왼쪽으로 이동', disabled: index === 0, onClick: () => move(-1) },
              { label: '오른쪽으로 이동', disabled: index === preferences.favorites.length - 1, onClick: () => move(1) },
              { separator: true }, ...folderMenu(favorite.path),
            ]);
          }}><Folder size={12} className="text-accent shrink-0" /><span className="truncate">{favorite.name}</span></button>
        ))}
      </nav>
      <div className="flex gap-1 px-2 py-1 flex-wrap shrink-0" aria-label="Local drives">
        {roots.map((root) => <button type="button" key={root} className="px-2 py-0.5 text-xs rounded hover:bg-surface2 focus-ring" onClick={() => navigate(root)}><HardDrive size={11} className="inline mr-1" />{root}</button>)}
      </div>
      <div className="px-2 pb-2 flex items-center gap-2 shrink-0">
        <input type="search" aria-label="Filter local files" placeholder="Filter this folder…" className="min-w-0 flex-1 bg-bg border border-border rounded px-2 py-1 text-xs focus-ring" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-1 text-xs whitespace-nowrap"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />Hidden</label>
      </div>
      {error && <p role="alert" className="mx-2 mb-2 p-2 text-xs break-words text-danger border border-danger/50 rounded">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={busy}>
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-surface2 text-muted text-left"><tr><th className="px-2 py-1 font-normal">Name</th><th className="px-2 py-1 font-normal text-right">Size</th></tr></thead>
          <tbody>{entries.map((entry) => (
            <tr key={entry.path} aria-selected={selected === entry.path} className={selected === entry.path ? 'bg-accent/15' : 'hover:bg-surface2'} onContextMenu={(event) => {
              event.preventDefault();
              setPopupMenu(null);
              setSelected(entry.path);
              setContextMenu({ x: Math.max(0, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - (entry.is_dir ? 250 : 170))), entry });
            }}>
              <td className="max-w-0 w-full"><button type="button" className="w-full text-left flex items-center gap-2 px-2 py-1 focus-ring" title={entry.is_dir ? entry.path : `${entry.path}\nDrag to a local shell to copy`} onPointerDown={(event) => {
                if (entry.is_dir) return;
                dragCancel.current?.();
                let hovered: HTMLElement | null = null;
                const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-local-copy-tab]') ?? null;
                dragCancel.current = beginPointerDrag(event, {
                  allowButton: true,
                  onDragStart: () => { setSelected(entry.path); setDraggingFile(entry.name); },
                  onDragMove: (x, y) => {
                    const target = targetAt(x, y);
                    if (target !== hovered) {
                      if (hovered) delete hovered.dataset.localCopyHover;
                      hovered = target;
                      if (hovered) hovered.dataset.localCopyHover = 'true';
                    }
                  },
                  onDrop: (x, y) => {
                    const target = targetAt(x, y);
                    const tabId = target?.dataset.localCopyTab;
                    if (tabId) window.dispatchEvent(new CustomEvent<LocalFileDrop>(LOCAL_FILE_DROP, { detail: { tabId, source: entry.path } }));
                    else toast.info('Copy file', 'Drop the file onto a connected local PowerShell or CMD terminal.');
                  },
                  onEnd: () => { if (hovered) delete hovered.dataset.localCopyHover; setDraggingFile(null); },
                });
              }} onClick={() => setSelected(entry.path)} onDoubleClick={() => { void openEntry(entry); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void openEntry(entry); } }}>
                <LocalFileIcon entry={entry} /><span className="truncate">{entry.name}</span>
              </button></td>
              <td className="px-2 py-1 text-muted text-right whitespace-nowrap">{entry.is_dir ? '—' : sizeLabel(entry.size)}</td>
            </tr>
          ))}</tbody>
        </table>
        {!busy && listing && entries.length === 0 && <p className="p-4 text-xs text-muted">{filter ? 'No matching files.' : 'This folder is empty.'}</p>}
      </div>
      {draggingFile && <div className="pointer-events-none absolute inset-x-2 bottom-14 z-50 p-3 rounded bg-surface2 border border-accent text-xs shadow-lg">Copy {draggingFile}<br />Drop onto a local PowerShell or CMD terminal.</div>}
      <footer className="border-t border-border p-2 text-xs text-muted shrink-0 break-words" aria-live="polite">
        {selectedEntry ? <><span className="text-fg">{selectedEntry.name}</span><br />{selectedEntry.is_dir ? 'Folder' : sizeLabel(selectedEntry.size)}{selectedEntry.modified != null && ` · ${new Date(selectedEntry.modified * 1000).toLocaleString()}`}</> : `${entries.length} items · Double-click a folder to open`}
      </footer>
      <ResizeHandle width={width} min={260} max={640} defaultWidth={360} onChange={setWidth} label="Resize local files" />
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={[
        { label: contextMenu.entry.is_dir ? '폴더 열기' : '열기 / 실행', onClick: () => { void openEntry(contextMenu.entry); } },
        { label: '파일 탐색기 열기', onClick: () => { void api.localFilesExplorer(contextMenu.entry.path).catch((e) => toast.danger('탐색기 열기 실패', errMessage(e))); } },
        { separator: true },
        { label: '파일 경로 복사', onClick: () => { void writeText(contextMenu.entry.path).then(() => toast.success('경로 복사 완료', contextMenu.entry.path)).catch((e) => toast.danger('경로 복사 실패', errMessage(e))); } },
        { label: '파일 복사', onClick: () => { void api.localFilesClipboard(contextMenu.entry.path).then(() => toast.success('파일 복사 완료', 'Windows 탐색기에서 Ctrl+V로 붙여넣을 수 있습니다.')).catch((e) => toast.danger('파일 복사 실패', errMessage(e))); } },
        ...(contextMenu.entry.is_dir ? [{ separator: true }, ...folderMenu(contextMenu.entry.path).slice(1)] : []),
      ]} />}
      {popupMenu && <ContextMenu x={popupMenu.x} y={popupMenu.y} items={popupMenu.items} onClose={() => setPopupMenu(null)} />}
      {renameFavorite && <PromptDialog title="즐겨찾기 이름 변경" label="이름" initialValue={renameFavorite.name} confirmText="저장" cancelText="취소" validate={(value) => value.trim().length > 100 ? '이름은 100자 이내로 입력하세요.' : null} onCancel={() => setRenameFavorite(null)} onConfirm={(name) => {
        savePreferences({ ...preferences, favorites: preferences.favorites.map((item) => folderKey(item.path) === folderKey(renameFavorite.path) ? { ...item, name } : item) });
        setRenameFavorite(null);
      }} />}
    </aside>
  );
}
