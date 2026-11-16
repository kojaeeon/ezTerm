/** Render Unix seconds in the PC's local timezone, independent of locale. */
export function formatFileModified(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null || !Number.isFinite(unixSeconds)) return '—';
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Enough width for all 19 timestamp characters, even in a narrow pane. */
export const FILE_MODIFIED_COL_W = 160;
