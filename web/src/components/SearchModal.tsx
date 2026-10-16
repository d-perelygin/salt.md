import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { SearchResult } from '../types';
import Portal from './Portal';
import { PageIcon } from '../pageIcon';
import { useExclusiveModal } from '../modal';
import { t } from '../i18n';
import { compare } from '../format';
import { openPage, openPageAux, peekPage } from '../pageOpen';
import { matchCommands, paletteCommands, runPaletteCommand, type PaletteCommand } from '../commands';

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The server wraps matches in \x01…\x02 so we can highlight them safely.
function snippetHtml(s: string) {
  return escapeHtml(s).replaceAll('\u0001', '<mark>').replaceAll('\u0002', '</mark>');
}

// Plain text out of BlockNote JSON for the read-only preview. Order matters,
// ranking does not — unlike the index extractor this walks in document order.
function previewText(content: unknown, budget = 600): string {
  const out: string[] = [];
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as { content?: unknown; children?: unknown };
      if (Array.isArray(b.content)) {
        for (const c of b.content) {
          if (!c || typeof c !== 'object') continue;
          const inline = c as { text?: unknown; props?: { label?: unknown } };
          if (typeof inline.text === 'string') out.push(inline.text);
          else if (typeof inline.props?.label === 'string') out.push(inline.props.label);
          if (out.join(' ').length >= budget) return;
        }
      }
      walk(b.children);
      if (out.join(' ').length >= budget) return;
    }
  };
  walk(content);
  const s = out.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > budget ? s.slice(0, budget) + '…' : s;
}

interface Props {
  recent?: { id: string; title: string; icon: string }[];
  workspaces: { id: string; name: string }[];
  currentWs: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
}

type NavItem =
  | { kind: 'result'; r: SearchResult }
  | { kind: 'recent'; r: { id: string; title: string; icon: string } }
  | { kind: 'command'; c: PaletteCommand & { aliases: string[] } };

export default function SearchModal({ recent, workspaces, currentWs, onClose, onNavigate, onOpenInNewTab }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  // Empty means everywhere; otherwise only the picked workspaces are searched.
  const [picked, setPicked] = useState<string[]>(() => (currentWs ? [currentWs] : []));
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState<{ id: string; title: string; ws: string; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  useExclusiveModal(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const wsKey = useMemo(() => [...picked].sort().join(','), [picked]);

  useEffect(() => {
    const cmdOnly = q.trimStart().startsWith('>');
    const cur = ++seq.current;
    const timer = window.setTimeout(async () => {
      const res = q.trim() && !cmdOnly ? await api.search(q, picked) : [];
      if (seq.current === cur) {
        setResults(res);
        setSel(0);
      }
    }, 150);
    return () => window.clearTimeout(timer);
    // picked is read through wsKey so the effect does not refire on identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, wsKey]);

  const cmdOnly = q.trimStart().startsWith('>');
  const cmdQuery = cmdOnly ? q.trimStart().slice(1) : q;
  // Recomputed per render: labels follow the language, `when` follows the screen.
  const allCmds = paletteCommands();
  const matchedCmds = useMemo(() => matchCommands(cmdQuery, allCmds), [cmdQuery, allCmds]);
  // In command mode (`>`) only commands; otherwise server hits first and the
  // matching commands after them. An empty query shows recents, then commands.
  const items: NavItem[] = useMemo(() => {
    if (cmdOnly) return matchedCmds.map((c) => ({ kind: 'command' as const, c }));
    const out: NavItem[] = results.map((r) => ({ kind: 'result' as const, r }));
    if (q.trim() === '') {
      for (const r of recent ?? []) out.push({ kind: 'recent' as const, r });
      for (const c of allCmds) out.push({ kind: 'command' as const, c });
    } else {
      for (const c of matchedCmds.slice(0, 5)) out.push({ kind: 'command' as const, c });
    }
    return out;
    // allCmds/matchedCmds are fresh arrays per render; identity deps would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, recent, q, cmdOnly]);

  // The selection follows the list: a shorter list must not strand it past the end.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // Read-only preview of the selected page, Notion-style: small type, and a
  // click opens the page in a new tab rather than editing in place.
  const previewId = (() => {
    const it = items[sel];
    if (!it || it.kind === 'command') return null;
    return it.r.id;
  })();
  useEffect(() => {
    if (!previewId) {
      setPreview(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .getPage(previewId)
        .then((p) => {
          if (!alive) return;
          setPreview({
            id: p.id,
            title: p.title,
            ws: workspaces.find((w) => w.id === p.workspaceId)?.name ?? '',
            text: previewText(p.content),
          });
        })
        .catch(() => {
          if (alive) setPreview(null);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [previewId, workspaces]);

  const openItem = (it: NavItem, e?: React.KeyboardEvent | React.MouseEvent) => {
    if (it.kind === 'command') {
      // Close first, then run on the next tick: command guards read modalOpen()
      // off the DOM, and the overlay is gone only after the unmount commits.
      const id = it.c.id;
      onClose();
      window.setTimeout(() => void runPaletteCommand(id), 0);
      return;
    }
    const id = it.r.id;
    if (e && 'key' in e && e.key === 'Enter') {
      // The click modifiers, on the keyboard: Option peeks (and closes the
      // palette), Ctrl/⌘ together with Alt stays, Ctrl/⌘ opens beside.
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        if (peekPage(e, id)) onClose();
        else onNavigate(id);
      } else if (e.altKey) onNavigate(id);
      else if (e.metaKey || e.ctrlKey) (onOpenInNewTab ?? onNavigate)(id);
      else onNavigate(id);
      return;
    }
    if (e && 'shiftKey' in e) {
      openPage(e as React.MouseEvent, id, { onNavigate, onOpenInNewTab });
      return;
    }
    onNavigate(id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return; // don't hijack IME composition keys
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && items[sel]) {
      openItem(items[sel], e);
    }
  };

  const toggleWs = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));

  const showResults = !cmdOnly && q.trim() !== '' && results.length > 0;
  const showCmdLabel = !cmdOnly && q.trim() !== '' && items.some((i) => i.kind === 'command');

  return (
    <Portal>
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={'search-modal' + (previewId ? ' has-preview' : '')} onKeyDown={onKey}>
        <div className="search-main">
          <input
            ref={inputRef}
            className="search-input"
            placeholder={t('Search all pages…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {workspaces.length > 1 && (
            <div className="search-scopes" role="group" aria-label={t('Workspaces')}>
              <button
                type="button"
                className={'search-scope' + (picked.length === 0 ? ' is-on' : '')}
                onClick={() => setPicked([])}
              >
                {t('Everywhere')}
              </button>
              {[...workspaces].sort((a, b) => compare(a.name, b.name)).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={'search-scope' + (picked.includes(w.id) ? ' is-on' : '')}
                  onClick={() => toggleWs(w.id)}
                  title={w.name}
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}
          <div className="search-results">
            {showResults &&
              results.map((r) => {
                const idx = items.findIndex((i) => (i.kind === 'result' || i.kind === 'recent') && i.r.id === r.id);
                return (
                  <button
                    key={r.id}
                    className={'search-result' + (idx === sel ? ' selected' : '')}
                    onMouseEnter={() => idx >= 0 && setSel(idx)}
                    onClick={(e) => openPage(e, r.id, { onNavigate, onOpenInNewTab })}
                    onAuxClick={(e) => openPageAux(e, r.id, { onNavigate, onOpenInNewTab })}
                  >
                    <span className="result-icon"><PageIcon icon={r.icon} size={16} fallback="📄" /></span>
                    <span className="result-body">
                      <span className="result-title">{r.title || t('Untitled')}</span>
                      {r.snippet && (
                        <span
                          className="result-snippet"
                          dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippet) }}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            {q.trim() !== '' && !cmdOnly && results.length === 0 && matchedCmds.length === 0 && (
              <div className="search-empty">{t('No results')}</div>
            )}
            {cmdOnly && matchedCmds.length === 0 && (
              <div className="search-empty">{t('No results')}</div>
            )}
            {q.trim() === '' && !cmdOnly && (recent?.length ?? 0) > 0 && (
              <>
                <div className="search-section-label">{t('Recently opened')}</div>
                {recent!.map((r) => {
                  const idx = items.findIndex((i) => i.kind === 'recent' && i.r.id === r.id);
                  return (
                    <button
                      key={r.id}
                      className={'search-result' + (idx === sel ? ' selected' : '')}
                      onMouseEnter={() => idx >= 0 && setSel(idx)}
                      onClick={(e) => openPage(e, r.id, { onNavigate, onOpenInNewTab })}
                      onAuxClick={(e) => openPageAux(e, r.id, { onNavigate, onOpenInNewTab })}
                    >
                      <span className="result-icon"><PageIcon icon={r.icon} size={16} fallback="📄" /></span>
                      <span className="result-body">
                        <span className="result-title">{r.title || t('Untitled')}</span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
            {(cmdOnly || showCmdLabel || (q.trim() === '' && !cmdOnly)) && (
              <>
                <div className="search-section-label">{t('Commands')}</div>
                {(cmdOnly ? matchedCmds : q.trim() === '' ? allCmds : matchedCmds.slice(0, 5)).map((c) => {
                  const idx = items.findIndex((i) => i.kind === 'command' && i.c.id === c.id);
                  return (
                    <button
                      key={c.id}
                      className={'search-result search-command' + (idx === sel ? ' selected' : '')}
                      onMouseEnter={() => idx >= 0 && setSel(idx)}
                      onClick={() => {
                        const it = items[idx];
                        if (it) openItem(it);
                      }}
                    >
                      <span className="result-body">
                        <span className="result-title">{c.label}</span>
                        {c.keys && <span className="result-keys">{c.keys}</span>}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
        {previewId && (
          <div
            className="search-preview"
            onClick={() => (onOpenInNewTab ?? onNavigate)(previewId)}
            title={t('Open in new tab')}
            role="button"
            tabIndex={-1}
          >
            <div className="search-preview-ws">{preview?.ws ?? ''}</div>
            <div className="search-preview-title">{preview?.title || t('Untitled')}</div>
            {preview?.text && <div className="search-preview-text">{preview.text}</div>}
          </div>
        )}
      </div>
    </div>
    </Portal>
  );
}
