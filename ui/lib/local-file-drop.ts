export const LOCAL_FILE_DROP = 'ezterm:local-file-drop';
export interface LocalFileDrop { tabId: string; source: string; }

/** Private OSC emitted by the Windows shell prompt, never by an SSH tab. */
export function parseLocalCwd(value: string): string | null {
  const prefix = 'ezterm-cwd;';
  if (!value.startsWith(prefix)) return null;
  const path = value.slice(prefix.length);
  if (/[\x00-\x1f]/.test(path)) return null;
  return /^[a-z]:\\/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) ? path : null;
}
