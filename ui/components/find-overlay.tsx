'use client';
import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';

// Decorations also enable the addon's result-count events.
const SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#725500',
  matchBorder: '#eab308',
  matchOverviewRuler: '#eab308',
  activeMatchBackground: '#9a3412',
  activeMatchBorder: '#fb923c',
  activeMatchColorOverviewRuler: '#fb923c',
};

export function FindOverlay({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [q, setQ]   = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [re, setRe] = useState(false);
  const [result, setResult] = useState<{ idx: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  let invalidRegex = false;
  if (re && q) {
    try { new RegExp(q); } catch { invalidRegex = true; }
  }

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResult(resultCount > 0 ? { idx: resultIndex + 1, count: resultCount } : null);
    });
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  // Debounce full-buffer highlighting while typing. Counting reuses the addon's
  // bounded highlight results (default limit: 1000), with no separate scan.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      search.findNext(invalidRegex ? '' : q, {
        caseSensitive, regex: re, incremental: true, decorations: SEARCH_DECORATIONS,
      });
    }, q && !invalidRegex ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [search, q, caseSensitive, re, invalidRegex]);

  function runNext() {
    if (q && !invalidRegex) search.findNext(q, { caseSensitive, regex: re, decorations: SEARCH_DECORATIONS });
  }
  function runPrev() {
    if (q && !invalidRegex) search.findPrevious(q, { caseSensitive, regex: re, decorations: SEARCH_DECORATIONS });
  }

  return (
    <div className="absolute top-2 right-2 bg-surface border border-border rounded-md px-1.5 py-1 flex items-center gap-1 text-xs shadow-menu">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) runPrev(); else runNext(); }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        aria-invalid={invalidRegex}
        className="bg-surface2 border border-border rounded-sm px-2 py-1 outline-none focus:border-accent w-44"
      />
      {q && (
        <span aria-live="polite" className="text-muted tabular-nums px-1 min-w-[48px] text-center">
          {invalidRegex ? 'Invalid regex' : result ? `${result.idx || '–'}/${result.count}${result.count >= 1000 ? '+' : ''}` : '0/0'}
        </span>
      )}
      <button
        type="button"
        onClick={() => setCaseSensitive((v) => !v)}
        aria-pressed={caseSensitive}
        title="Case sensitive"
        className="icon-btn w-6 h-6"
      >
        <CaseSensitive size={13} />
      </button>
      <button
        type="button"
        onClick={() => setRe((v) => !v)}
        aria-pressed={re}
        title="Regular expression"
        className="icon-btn w-6 h-6"
      >
        <Regex size={13} />
      </button>
      <button type="button" onClick={runPrev} aria-label="Previous match" title="Previous (Shift+Enter)" className="icon-btn w-6 h-6">
        <ChevronUp size={13} />
      </button>
      <button type="button" onClick={runNext} aria-label="Next match" title="Next (Enter)" className="icon-btn w-6 h-6">
        <ChevronDown size={13} />
      </button>
      <button type="button" onClick={onClose} aria-label="Close find" title="Close (Esc)" className="icon-btn w-6 h-6">
        <X size={13} />
      </button>
    </div>
  );
}
