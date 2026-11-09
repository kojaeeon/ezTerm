'use client';
import { useCallback, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { errMessage } from '@/lib/tauri';
import { toast } from '@/lib/toast';
import { ContextMenu } from './context-menu';

interface Props {
  path: string;
  onNavigate: (p: string) => Promise<void>;
  disabled?: boolean;
}

/** Click to edit the current path; right-click to copy its full address. */
export function SftpBreadcrumb({ path, onNavigate, disabled = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const submitting = useRef(false);
  const focusAddress = useCallback((input: HTMLInputElement | null) => {
    if (input) { input.focus(); input.select(); }
  }, []);

  function startEditing() {
    if (disabled || busy) return;
    setMenu(null);
    setDraft(path);
    setEditing(true);
  }

  async function submit() {
    if (disabled || submitting.current) return;
    const target = draft.trim();
    if (!target) return;
    submitting.current = true;
    setBusy(true);
    try {
      await onNavigate(target);
      setEditing(false);
    } catch (error) {
      toast.danger('폴더 이동 실패', errMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function copyAddress(address: string) {
    try {
      await writeText(address);
      toast.success('주소를 복사했습니다');
    } catch (error) {
      toast.danger('주소 복사 실패', errMessage(error));
    }
  }

  return (
    <div
      className="min-w-0"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({
          x: Math.max(0, Math.min(event.clientX, window.innerWidth - 208)),
          y: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)),
          path,
        });
      }}
    >
      {editing ? (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input
            ref={focusAddress}
            aria-label="Remote path"
            aria-busy={busy}
            title="Enter: 이동 · Esc: 취소"
            className="input w-full min-w-0 h-6 px-1 text-xs font-mono"
            value={draft}
            readOnly={busy}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { if (!submitting.current) setEditing(false); }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape' && !submitting.current) {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          aria-label="Edit remote path"
          disabled={disabled || busy}
          title={`${path}\n왼쪽 클릭: 주소 입력 · 오른쪽 클릭: 주소 복사`}
          className="block w-full min-w-0 h-6 px-1 rounded text-left text-xs font-mono text-muted truncate hover:text-fg hover:bg-surface2 focus-ring disabled:opacity-50"
          onClick={startEditing}
        >
          {path}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: '주소 복사', onClick: () => { void copyAddress(menu.path); } }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
