import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRemoteCwd, remoteCwdCommand, remoteEditCommand } from './remote-cwd';

describe('SSH editor current directory', () => {
  const token = 'abc-123';

  it('runs pwd in the same shell and preserves spaces and shell punctuation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ezterm space;$-'));
    try {
      const command = remoteCwdCommand(token).replace(/\r$/, '\n');
      const output = execFileSync('sh', ['-c', command], { cwd: directory, encoding: 'utf8' });
      expect(output).toBe(`\x1b]777;ezterm-edit-cwd;${token};${directory}\x07`);
      expect(parseRemoteCwd(output.slice(6, -1), token)).toBe(directory);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('ignores stale probes and rejects non-absolute or control-character paths', () => {
    expect(parseRemoteCwd('ezterm-edit-cwd;old;/tmp', token)).toBeNull();
    for (const path of ['', 'relative', '/tmp\nfile', '/tmp\x1bfile']) {
      expect(parseRemoteCwd(`ezterm-edit-cwd;${token};${path}`, token)).toBeNull();
    }
    expect(parseRemoteCwd(`ezterm-edit-cwd;${token};/한글 dir;a`, token)).toBe('/한글 dir;a');
    expect(() => remoteCwdCommand("';bad")).toThrow();
  });

  it('prefills a single trailing slash, including the root directory', () => {
    expect(remoteEditCommand('/srv/app')).toBe('ezedit /srv/app/');
    expect(remoteEditCommand('/srv/app/')).toBe('ezedit /srv/app/');
    expect(remoteEditCommand('/')).toBe('ezedit /');
  });
});
