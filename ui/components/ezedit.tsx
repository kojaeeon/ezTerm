'use client';

import { Channel } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getSetting } from '@/lib/settings';
import { createOutputChannel } from '@/lib/ssh';
import { remoteEditCommand } from '@/lib/remote-cwd';
import { api, errMessage, type EzEditEncoding } from '@/lib/tauri';
import { toast } from '@/lib/toast';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';

export function EzEdit({ connectionId, localCwd, remoteCwd, initialPath, visible, onClose }: {
  connectionId: number;
  localCwd?: string | null;
  remoteCwd?: string | null;
  initialPath?: string;
  visible: boolean;
  onClose: () => void;
}) {
  const isLocal = localCwd !== undefined;
  const [command, setCommand] = useState(() => {
    if (initialPath) return `ezedit ${initialPath}`;
    return remoteCwd ? remoteEditCommand(remoteCwd) : 'ezedit ';
  });
  const [path, setPath] = useState(initialPath ?? '');
  const [error, setError] = useState('');
  const [encoding, setEncoding] = useState<EzEditEncoding | null>(null);
  const [encodingPrompt, setEncodingPrompt] = useState<{
    path: string;
    detected: EzEditEncoding | null;
  } | null>(null);
  const encodingButton = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const bundleRef = useRef<TerminalBundle | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!visible) return;
    if (encodingPrompt) encodingButton.current?.focus();
    else if (!path) input.current?.focus();
    else if (ready) bundleRef.current?.terminal.focus();
  }, [visible, path, ready, encodingPrompt]);

  useEffect(() => {
    const container = mount.current;
    if (!path || !container) return;
    let active = true;
    let editorId: number | null = null;
    let cleanup: (() => void) | undefined;

    // Wait until React's development-mode effect replay has settled before
    // opening xterm and starting the native process.
    queueMicrotask(() => {
      if (!active) return;
      const bundle = createTerminal({ palette: getSetting('terminal.palette'), scrollback: 0 });
      const terminal = bundle.terminal;
      bundleRef.current = bundle;
      terminal.open(container);
      if (container.clientWidth && container.clientHeight) bundle.fit.fit();

      const output = createOutputChannel((bytes) => terminal.write(bytes));
      const processReady = new Channel<number>((id) => {
        if (!active) {
          void api.localDisconnect(id).catch(() => {});
          return;
        }
        editorId = id;
        output.arm();
        setReady(true);
        void api.localResize(id, terminal.cols, terminal.rows).catch(() => {});
      });
      const data = terminal.onData((text) => {
        if (editorId !== null) {
          const bytes = Array.from(new TextEncoder().encode(text));
          void api.localWrite(editorId, bytes).catch(() => {});
        }
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
        if (event.code === 'KeyV') {
          event.preventDefault();
          void readText().then((text) => { if (active) terminal.paste(text); }).catch(() => {});
          return false;
        }
        if (event.code === 'KeyC') {
          event.preventDefault();
          const text = terminal.getSelection();
          if (text) void writeText(text).catch(() => {});
          return false;
        }
        return true;
      });
      const resize = terminal.onResize(({ cols, rows }) => {
        if (editorId !== null) void api.localResize(editorId, cols, rows).catch(() => {});
      });
      const observer = new ResizeObserver(() => {
        if (active && container.clientWidth && container.clientHeight) bundle.fit.fit();
      });
      observer.observe(container);
      cleanup = () => {
        observer.disconnect();
        output.detach();
        data.dispose();
        resize.dispose();
        bundle.dispose();
        bundleRef.current = null;
      };

      const size: [number, number] = [terminal.cols, terminal.rows];
      const editing = localCwd === undefined
        ? api.ezedit(connectionId, path, encoding, size, processReady, output.channel)
        : api.ezeditLocal(connectionId, path, localCwd, encoding, size, processReady, output.channel);
      void editing
        .then((result) => {
          if (result.status === 'choose_encoding') {
            if (active) {
              setEncodingPrompt({ path, detected: result.detected });
              setPath('');
            }
            return;
          }
          if (result.saved) toast.success(localCwd === undefined ? 'Remote file saved' : 'Local file saved', path);
          if (active) onCloseRef.current();
        })
        .catch((cause: unknown) => {
          const message = errMessage(cause);
          if (!active) {
            toast.danger('ezedit', message);
            return;
          }
          setError(message);
          setReady(false);
          setPath('');
        });
    });

    return () => {
      active = false;
      if (editorId !== null) void api.localDisconnect(editorId).catch(() => {});
      cleanup?.();
    };
  }, [connectionId, localCwd, path, encoding]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const match = /^ezedit[ \t]+([^\r\n]+)$/.exec(command.trimStart());
    let file = match?.[1] ?? '';
    if (isLocal) {
      file = file.trim();
      if (file.length >= 2 && ((file.startsWith('"') && file.endsWith('"'))
          || (file.startsWith("'") && file.endsWith("'")))) {
        file = file.slice(1, -1);
      }
    }
    if (!file || (!isLocal && !file.startsWith('/'))) {
      setError(isLocal
        ? 'Enter ezedit followed by a local file path.'
        : 'Enter ezedit followed by an absolute path, for example ezedit /app/config.yml.');
      return;
    }
    setError('');
    setEncoding(null);
    setPath(file);
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-bg/85"
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {encodingPrompt ? (
        <div className="w-[34rem] max-w-[94%] rounded border border-border bg-surface p-4 shadow-dialog"
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
          <p className="text-sm font-medium">This file could not be opened as UTF-8</p>
          <p className="my-2 break-all font-mono text-xs text-muted">{encodingPrompt.path}</p>
          {encodingPrompt.detected && <p className="mb-3 text-sm">Detected encoding: ISO-8859-1 (estimated)</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn-ghost" onClick={() => setEncodingPrompt(null)}>Back</button>
            <button type="button" ref={encodingButton} className="btn-primary" onClick={() => {
              setEncoding('iso-8859-1');
              setPath(encodingPrompt.path);
              setEncodingPrompt(null);
            }}>{encodingPrompt.detected ? 'Open as ISO-8859-1' : 'Try ISO-8859-1'}</button>
          </div>
        </div>
      ) : !path ? (
        <form onSubmit={submit} className="w-[34rem] max-w-[94%] rounded border border-border bg-surface p-4 shadow-dialog">
          <label className="block text-sm font-medium" htmlFor={`ezedit-${connectionId}`}>{isLocal ? 'Edit a local file' : 'Edit a remote file'}</label>
          <input
            ref={input}
            id={`ezedit-${connectionId}`}
            className="my-2 w-full rounded border border-border bg-bg p-2 font-mono text-sm"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
            }}
            spellCheck={false}
          />
          {error && <p role="alert" className="mb-2 select-text break-words text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
            <button type="submit" className="btn-primary">Open</button>
          </div>
        </form>
      ) : (
        <div className="flex h-full w-full flex-col bg-bg">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1 text-xs">
            <span className="min-w-0 truncate font-mono" title={path}>Helix · {path}{encoding && ' · ISO-8859-1'}</span>
            <span className="shrink-0 text-muted">{ready ? ':wq to save and close · :q! to discard unsaved edits' : 'Opening file…'}</span>
          </div>
          <div ref={mount} className="min-h-0 flex-1 p-1" />
        </div>
      )}
    </div>
  );
}
