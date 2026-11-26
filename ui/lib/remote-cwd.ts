/** Probe the interactive SSH shell, not a new SSH exec channel (which starts at home). */
export function remoteCwdCommand(token: string): string {
  if (!/^[a-f0-9-]+$/.test(token)) throw new Error('Invalid cwd probe token');
  return `printf '\\033]777;ezterm-edit-cwd;${token};%s\\007' "$(pwd)"\r`;
}

export function parseRemoteCwd(value: string, token: string): string | null {
  const prefix = `ezterm-edit-cwd;${token};`;
  if (!value.startsWith(prefix)) return null;
  const path = value.slice(prefix.length);
  return path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path) ? path : null;
}

export function remoteEditCommand(cwd: string): string {
  return `ezedit ${cwd.endsWith('/') ? cwd : `${cwd}/`}`;
}
