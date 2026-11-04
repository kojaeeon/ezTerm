import { describe, expect, it } from 'vitest';
import { parseLocalCwd } from './local-file-drop';

describe('local shell copy destination', () => {
  it('preserves spaces, Unicode, percent and semicolons in actual folder paths', () => {
    expect(parseLocalCwd('ezterm-cwd;D:\\한글 space\\100%;folder')).toBe('D:\\한글 space\\100%;folder');
    expect(parseLocalCwd('ezterm-cwd;\\\\server\\share\\folder')).toBe('\\\\server\\share\\folder');
  });
  it('rejects unrelated, relative, empty, and control-containing reports', () => {
    for (const value of ['other;C:\\', 'ezterm-cwd;', 'ezterm-cwd;C:relative', 'ezterm-cwd;Registry::HKEY_LOCAL_MACHINE', 'ezterm-cwd;C:\\bad\npath']) {
      expect(parseLocalCwd(value)).toBeNull();
    }
  });
});
