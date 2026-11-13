import type { IBuffer } from '@xterm/xterm';

/** Use local time and a portable filename, retaining readable Unicode names. */
export function terminalLogFilename(tabName: string, date = new Date()): string {
  const name = Array.from(tabName.trim(), (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || /[<>:"/\\|?*]/.test(char) ? '_' : char,
  ).slice(0, 50).join('').replace(/[. ]+$/g, '') || 'terminal';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${name}_${day}_${time}.log`;
}

/** Snapshot rendered text, including scrollback, without ANSI escape codes.
 * Rejoin soft-wrapped rows so the terminal width doesn't become log newlines.
 * This does not change the user's selection or retain a second output buffer. */
export function terminalLogText(buffer: Pick<IBuffer, 'length' | 'getLine'>): string {
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const nextWrapped = buffer.getLine(row + 1)?.isWrapped ?? false;
    const text = line.translateToString(!nextWrapped);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  // xterm's buffer includes unused rows below the prompt.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : '';
}
