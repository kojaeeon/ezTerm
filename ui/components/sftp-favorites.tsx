'use client';
import { useState, useSyncExternalStore } from 'react';
import { Star } from 'lucide-react';
import type { Session } from '@/lib/types';
import { parseSftpFavorites, remoteFolderKey, sftpFavoritesKey, SFTP_FAVORITES_CHANGED, type SftpFavorite } from '@/lib/sftp-favorites';
import { toast } from '@/lib/toast';
import { ContextMenu } from './context-menu';
import { PromptDialog } from './prompt-dialog';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(SFTP_FAVORITES_CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(SFTP_FAVORITES_CHANGED, onChange);
  };
}

export function SftpFavorites({ session, path, enabled, onNavigate }: {
  session: Session; path: string; enabled: boolean; onNavigate: (path: string) => void;
}) {
  const key = sftpFavoritesKey(session);
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const favorites = parseSftpFavorites(raw);
  const [menu, setMenu] = useState<{ x: number; y: number; favorite: SftpFavorite } | null>(null);
  const [renaming, setRenaming] = useState<SftpFavorite | null>(null);
  const currentPath = remoteFolderKey(path);
  const saved = favorites.some((item) => item.path === currentPath);

  function save(update: (current: SftpFavorite[]) => SftpFavorite[]) {
    try {
      // Read at mutation time so another tab's additions are retained.
      localStorage.setItem(key, JSON.stringify(update(parseSftpFavorites(read()))));
      window.dispatchEvent(new Event(SFTP_FAVORITES_CHANGED));
    } catch { toast.danger('즐겨찾기 저장 실패', '저장 공간을 사용할 수 없습니다.'); }
  }

  function toggle() {
    save((current) => {
      if (current.some((item) => item.path === currentPath)) return current.filter((item) => item.path !== currentPath);
      if (current.length >= 100) {
        toast.info('즐겨찾기', '서버별로 최대 100개까지 저장할 수 있습니다.');
        return current;
      }
      return [...current, { path: currentPath, name: currentPath.split('/').pop() || '/' }];
    });
  }

  return (
    <div className="border-b border-border px-1.5 py-1 flex items-center gap-1 shrink-0 text-xs">
      <button type="button" className={`icon-btn shrink-0 ${saved ? 'text-accent' : ''}`}
        title={saved ? '현재 폴더 즐겨찾기 해제' : '현재 폴더 즐겨찾기 추가'}
        aria-label={saved ? '현재 폴더 즐겨찾기 해제' : '현재 폴더 즐겨찾기 추가'}
        aria-pressed={saved} disabled={!enabled || !path.startsWith('/')} onClick={toggle}>
        <Star size={13} fill={saved ? 'currentColor' : 'none'} />
      </button>
      <nav aria-label="SFTP 즐겨찾기" className="flex items-center gap-1 overflow-x-auto min-w-0">
        {favorites.length === 0 && <span className="text-muted whitespace-nowrap">별을 눌러 현재 폴더를 저장하세요</span>}
        {favorites.map((favorite) => (
          <button key={favorite.path} type="button" disabled={!enabled} title={favorite.path}
            aria-current={favorite.path === currentPath ? 'location' : undefined}
            className={`px-2 py-1 max-w-36 shrink-0 truncate rounded focus-ring hover:bg-surface2 ${favorite.path === currentPath ? 'text-accent bg-accent/10' : 'text-muted'}`}
            onClick={() => onNavigate(favorite.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: Math.max(0, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 100)), favorite });
            }}>
            {favorite.name}
          </button>
        ))}
      </nav>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
        { label: '이름 변경…', onClick: () => { setRenaming(menu.favorite); setMenu(null); } },
        { label: '즐겨찾기 삭제', onClick: () => { save((current) => current.filter((item) => item.path !== menu.favorite.path)); setMenu(null); } },
      ]} />}
      {renaming && <PromptDialog title="즐겨찾기 이름 변경" label="이름" initialValue={renaming.name}
        confirmText="저장" cancelText="취소" onCancel={() => setRenaming(null)}
        validate={(name) => !name.trim() ? '이름을 입력하세요.' : name.trim().length > 100 ? '이름은 100자 이내로 입력하세요.' : null}
        onConfirm={(name) => {
          save((current) => current.map((item) => item.path === renaming.path ? { ...item, name: name.trim() } : item));
          setRenaming(null);
        }} />}
    </div>
  );
}
