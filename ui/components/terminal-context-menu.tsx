'use client';
import { ContextMenu, type MenuItem } from './context-menu';

export interface TerminalMenuProps {
  x: number; y: number;
  hasSelection: boolean;
  onCopy:       () => void;
  onPaste:      () => void;
  onSelectAll:  () => void;
  onClear:      () => void;
  onFind:       () => void;
  onSaveLog:    () => void;
  onFont:       () => void;
  /** Available for local shells; disabled until the shell reports its folder. */
  onOpenExplorer?: () => void;
  canOpenExplorer?: boolean;
  /** Present only for tabs running in a persistent tmux/screen session. */
  onEndRemote?: () => void;
  onClose:      () => void;
}

export function TerminalContextMenu(p: TerminalMenuProps) {
  const items: MenuItem[] = [
    { label: 'Copy',             shortcut: 'Ctrl+Shift+C', disabled: !p.hasSelection, onClick: p.onCopy },
    { label: 'Paste',            shortcut: 'Shift+Insert', onClick: p.onPaste },
    { label: 'Select All',       onClick: p.onSelectAll },
    { label: 'Find…',            shortcut: 'Ctrl+Shift+F', onClick: p.onFind },
    { label: 'Save output as log…', onClick: p.onSaveLog },
    { separator: true },
    { label: 'Font…',            shortcut: 'Ctrl+Wheel',   onClick: p.onFont },
    { label: 'Clear scrollback', onClick: p.onClear },
  ];
  if (p.onOpenExplorer) {
    items.push(
      { separator: true },
      { label: 'Open in File Explorer', disabled: !p.canOpenExplorer, onClick: p.onOpenExplorer },
    );
  }
  if (p.onEndRemote) {
    items.push(
      { separator: true },
      { label: 'End remote session…', danger: true, onClick: p.onEndRemote },
    );
  }
  return <ContextMenu x={p.x} y={p.y} items={items} onClose={p.onClose} />;
}
