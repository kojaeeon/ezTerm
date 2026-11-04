'use client';
import { useEffect, useRef, useState } from 'react';
import { File, Folder } from 'lucide-react';
import { api, type LocalEntry } from '@/lib/tauri';

const cache = new Map<string, string | null>();
const pending = new Map<string, { path: string; resolve: (icon: string | null) => void }>();
const inFlight = new Map<string, Promise<string | null>>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  timer = undefined;
  const batch = [...pending.entries()].slice(0, 32);
  for (const [key] of batch) pending.delete(key);
  try {
    const icons = await api.localFilesIcons(batch.map(([, request]) => request.path));
    for (const [key, request] of batch) {
      const icon = icons[request.path] ?? null;
      cache.set(key, icon);
      if (cache.size > 1024) cache.delete(cache.keys().next().value!);
      request.resolve(icon);
      inFlight.delete(key);
    }
  } catch {
    for (const [key, request] of batch) { request.resolve(null); inFlight.delete(key); }
  }
  if (pending.size > 0) schedule();
}
function schedule() { if (timer === undefined) timer = setTimeout(() => { void flush(); }, 20); }
function loadIcon(entry: LocalEntry): Promise<string | null> {
  const key = `${entry.path}\0${entry.modified}\0${entry.size}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = new Promise<string | null>((resolve) => { pending.set(key, { path: entry.path, resolve }); });
  inFlight.set(key, promise);
  schedule();
  return promise;
}

export function LocalFileIcon({ entry }: { entry: LocalEntry }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const load = () => { void loadIcon(entry).then((result) => { if (!disposed) setIcon(result); }); };
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) { load(); observer.disconnect(); }
    }, { rootMargin: '100px' });
    if (ref.current) observer.observe(ref.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [entry]);
  return <span ref={ref} className="shrink-0 w-4 h-4 flex items-center justify-center" aria-hidden>
    {/* Native shell icons are already sized and encoded locally. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {icon ? <img src={icon} width={16} height={16} alt="" draggable={false} />
      : entry.is_dir ? <Folder size={14} className="text-accent" /> : <File size={14} className="text-muted" />}
  </span>;
}
