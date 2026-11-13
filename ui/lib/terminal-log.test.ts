import { describe, expect, it } from 'vitest';
import type { IBuffer, IBufferLine } from '@xterm/xterm';
import { terminalLogFilename, terminalLogText } from './terminal-log';

function buffer(rows: { text: string; wrapped?: boolean }[]): Pick<IBuffer, 'length' | 'getLine'> {
  return {
    length: rows.length,
    getLine: (index) => {
      const row = rows[index];
      if (!row) return undefined;
      return {
        isWrapped: row.wrapped ?? false,
        translateToString: (trimRight: boolean) => trimRight ? row.text.trimEnd() : row.text,
      } as IBufferLine;
    },
  };
}

describe('terminalLogFilename', () => {
  const date = new Date(2026, 10, 13, 9, 5, 7);

  it('uses the tab name and local date/time with zero padding', () => {
    expect(terminalLogFilename('개발 SSH', date)).toBe('개발 SSH_20261113_090507.log');
  });

  it('replaces Windows path characters and control characters', () => {
    expect(terminalLogFilename('dev:/\\<>:"|?*\n\tA', date))
      .toBe('dev____________A_20261113_090507.log');
  });

  it('uses a fallback for an empty or dots-only tab name', () => {
    expect(terminalLogFilename(' ... ', date)).toBe('terminal_20261113_090507.log');
    expect(terminalLogFilename('', date)).toBe('terminal_20261113_090507.log');
  });

  it('bounds long names without breaking Unicode characters', () => {
    expect(terminalLogFilename('가'.repeat(200), date)).toBe(`${'가'.repeat(50)}_20261113_090507.log`);
  });
});

describe('terminalLogText', () => {
  it('keeps scrollback, Unicode and real blank lines, removing unused bottom rows', () => {
    expect(terminalLogText(buffer([
      { text: 'earlier output   ' }, { text: '' }, { text: '한글 😀 prompt> ' },
      { text: '   ' }, { text: '' },
    ]))).toBe('earlier output\n\n한글 😀 prompt>\n');
  });

  it('rejoins soft wraps and preserves spaces at wrap boundaries', () => {
    expect(terminalLogText(buffer([
      { text: 'hello ' }, { text: 'world ', wrapped: true },
      { text: '한글    ', wrapped: true }, { text: 'new line' },
    ]))).toBe('hello world 한글\nnew line\n');
  });

  it('handles a trimmed scrollback starting with a wrapped row', () => {
    expect(terminalLogText(buffer([{ text: 'continued', wrapped: true }])))
      .toBe('continued\n');
  });

  it('handles an empty terminal', () => {
    expect(terminalLogText(buffer([{ text: '   ' }, { text: '' }]))).toBe('');
    expect(terminalLogText(buffer([]))).toBe('');
  });
});
