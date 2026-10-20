import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, PanelRight, SlidersHorizontal } from 'lucide-react';
import { api } from '../api';
import type { PageMeta, SearchResult, User } from '../types';
import Portal from './Portal';
import Editor from './Editor';
import { PageIcon } from '../pageIcon';
import { useExclusiveModal } from '../modal';
import { t } from '../i18n';
import { compare } from '../format';
import { openPage, openPageAux, peekPage } from '../pageOpen';
import { matchCommands, paletteCommands, runPaletteCommand, workspaceSwitchCommands, type PaletteCommand } from '../commands';

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Where a hit lives: its workspace, plus the collection for a row. The
// server carries both ids on every hit (see searchResult); the names resolve
// locally, so no extra round trip is needed.
function resultContext(r: SearchResult, workspaces: { id: string; name: string }[]) {
  const parts: string[] = [];
  const ws = workspaces.find((w) => w.id === r.workspaceId)?.name;
  if (ws) parts.push(ws);
  if (r.parentTitle) parts.push(r.parentTitle);
  return parts.join(' · ');
}

// The server wraps matches in \x01…\x02 so we can highlight them safely.
function snippetHtml(s: string) {
  return escapeHtml(s).replaceAll('\u0001', '<mark>').replaceAll('\u0002', '</mark>');
}

interface Props {
  recent?: { id: string; title: string; icon: string }[];
  workspaces: { id: string; name: string }[];
  currentWs: string;
  pagesById: Map<string, PageMeta>;
  user: User;
  theme: 'light' | 'dark';
  tagColors: Record<string, string>;
  favorites: string[];
  onSetTagColor: (tag: string, color: string) => void;
  onToggleFavorite: (id: string) => void;
  onMetaChange: (id: string, patch: Partial<PageMeta>) => void;
  onTrash: (id: string) => void;
  onPagesChanged: () => void;
  onCreatePage: (parentId: string | null, type?: 'doc' | 'collection') => void;
  onMenu: () => void;
  onMissing: (id: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
}

type NavItem =
  | { kind: 'result'; r: SearchResult }
  | { kind: 'recent'; r: { id: string; title: string; icon: string } }
  | { kind: 'command'; c: PaletteCommand & { aliases: string[] } };

export default function SearchModal({
  recent,
  workspaces,
  currentWs,
  pagesById,
  user,
  theme,
  tagColors,
  favorites,
  onSetTagColor,
  onToggleFavorite,
  onMetaChange,
  onTrash,
  onPagesChanged,
  onCreatePage,
  onMenu,
  onMissing,
  onSwitchWorkspace,
  onClose,
  onNavigate,
  onOpenInNewTab,
}: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  // The preview pane: on unless explicitly hidden, remembered across sessions.
  const [showPreview, setShowPreview] = useState(() => {
    try {
      return localStorage.getItem('salt-search-preview') !== '0';
    } catch {
      return true;
    }
  });
  const [rememberWs, setRememberWs] = useState(() => {
    try {
      return localStorage.getItem('salt-search-remember-ws') === '1';
    } catch {
      return false;
    }
  });
  // Empty means everywhere; otherwise only the picked workspaces are searched.
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      if (localStorage.getItem('salt-search-remember-ws') === '1') {
        const saved = JSON.parse(localStorage.getItem('salt-search-ws') ?? '[]') as unknown;
        if (Array.isArray(saved)) {
          return (saved as unknown[]).filter(
            (x): x is string => typeof x === 'string' && workspaces.some((w) => w.id === x),
          );
        }
      }
    } catch {
      /* corrupted cache — fall through to the default */
    }
    return currentWs ? [currentWs] : [];
  });
  // How a preview click opens the page: in the current tab (default) or in
  // a new one. Remembered across sessions, next to the scope memory.
  const [previewNewTab, setPreviewNewTab] = useState(() => {
    try {
      // Renamed from salt-search-preview-newtab; the old key is honored once.
      const cur = localStorage.getItem('salt-search-newtab');
      if (cur !== null) return cur === '1';
      return localStorage.getItem('salt-search-preview-newtab') === '1';
    } catch {
      return false;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sel, setSel] = useState(0);
  // The page the preview Editor shows. Trails the selection on a short delay
  // so arrowing through results does not remount (and reconnect) an editor
  // per row; the stale page stays mounted meanwhile instead of flickering.
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
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
  // (Deliberately not memoized: the registry answers for right now.)
  const allCmds = [...paletteCommands(), ...workspaceSwitchCommands(workspaces)];
  const matchedCmds = useMemo(() => matchCommands(cmdQuery, allCmds), [cmdQuery, allCmds]);
  // In command mode (`>`) only commands; otherwise server hits first and the
  // matching commands after them. An empty query shows recents first, then
  // workspaces, then commands; a typed query leads with workspaces.
  const items: NavItem[] = useMemo(() => {
    const isWs = (c: PaletteCommand & { aliases: string[] }) => c.id.startsWith('ws:');
    if (cmdOnly) {
      const ws = matchedCmds.filter(isWs);
      const rest = matchedCmds.filter((c) => !isWs(c));
      return [...ws, ...rest].map((c) => ({ kind: 'command' as const, c }));
    }
    const ws = matchedCmds.filter(isWs);
    const rest = (list: (PaletteCommand & { aliases: string[] })[]) => list.filter((c) => !isWs(c));
    if (q.trim() === '') {
      const out: NavItem[] = [];
      for (const r of recent ?? []) out.push({ kind: 'recent' as const, r });
      for (const c of ws) out.push({ kind: 'command' as const, c });
      for (const c of rest(allCmds)) out.push({ kind: 'command' as const, c });
      return out;
    }
    const out: NavItem[] = ws.map((c) => ({ kind: 'command' as const, c }));
    for (const r of results) out.push({ kind: 'result' as const, r });
    for (const c of rest(matchedCmds).slice(0, 5)) out.push({ kind: 'command' as const, c });
    return out;
    // allCmds/matchedCmds are fresh arrays per render; identity deps would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, recent, q, cmdOnly]);

  // The selection follows the list: a shorter list must not strand it past the end.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // The selected page, if the selection sits on one rather than on a command.
  const previewId = (() => {
    const it = items[sel];
    if (!it || it.kind === 'command') return null;
    return it.r.id;
  })();

  // A preview click lands in the current tab; the icon beside it opens a new
  // one — unless remembered otherwise in the footer settings.
  const openPreview = () => {
    if (!previewId) return;
    if (previewNewTab) (onOpenInNewTab ?? onNavigate)(previewId);
    else onNavigate(previewId);
  };
  useEffect(() => {
    if (!previewId) {
      setPreviewPageId(null);
      return;
    }
    const timer = window.setTimeout(() => setPreviewPageId(previewId), 220);
    return () => window.clearTimeout(timer);
  }, [previewId]);

  // When on, every plain activation opens a new tab: result rows, recents
  // and preview clicks alike. Modified clicks keep their meaning.
  const openPageId = (id: string) => (previewNewTab ? (onOpenInNewTab ?? onNavigate)(id) : onNavigate(id));

  const openRowClick = (e: React.MouseEvent, id: string) => {
    if (e.button === 0 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      openPageId(id);
      return;
    }
    openPage(e, id, { onNavigate, onOpenInNewTab });
  };

  const openItem = (it: NavItem, e?: React.KeyboardEvent | React.MouseEvent) => {
    if (it.kind === 'command') {
      const id = it.c.id;
      // Workspace rows are not registry shortcuts: switch directly.
      if (id.startsWith('ws:')) {
        onClose();
        onSwitchWorkspace(id.slice('ws:'.length));
        return;
      }
      // Close first, then run on the next tick: command guards read modalOpen()
      // off the DOM, and the overlay is gone only after the unmount commits.
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
      else openPageId(id);
      return;
    }
    if (e && 'shiftKey' in e) {
      openRowClick(e as React.MouseEvent, id);
      return;
    }
    openPageId(id);
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
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && q === '' && workspaces.length > 1) {
      // Empty query: ←/→ picks the search scope, one workspace at a time.
      // (With text in the box the arrows move the caret as usual.)
      e.preventDefault();
      const ids = [...workspaces].sort((a, b) => compare(a.name, b.name)).map((w) => w.id);
      const at = picked.length === 1 && ids.includes(picked[0]) ? ids.indexOf(picked[0]) + 1 : 0;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = (at + dir + ids.length + 1) % (ids.length + 1);
      setPicked(next === 0 ? [] : [ids[next - 1]]);
    } else if (e.key === 'Enter' && items[sel]) {
      openItem(items[sel], e);
    }
  };

  const togglePreview = () =>
    setShowPreview((v) => {
      const next = !v;
      try {
        localStorage.setItem('salt-search-preview', next ? '1' : '0');
      } catch {
        /* private mode — the pane still toggles for this session */
      }
      return next;
    });

  const toggleRememberWs = () =>
    setRememberWs((v) => {
      const next = !v;
      try {
        localStorage.setItem('salt-search-remember-ws', next ? '1' : '0');
        if (next) localStorage.setItem('salt-search-ws', JSON.stringify(picked));
        else localStorage.removeItem('salt-search-ws');
      } catch {
        /* private mode — the choice still applies for this session */
      }
      return next;
    });

  const togglePreviewNewTab = () =>
    setPreviewNewTab((v) => {
      const next = !v;
      try {
        localStorage.setItem('salt-search-newtab', next ? '1' : '0');
      } catch {
        /* private mode — the choice still applies for this session */
      }
      return next;
    });

  // The remembered scope follows the picks while remembering is on.
  useEffect(() => {
    if (!rememberWs) return;
    try {
      localStorage.setItem('salt-search-ws', JSON.stringify(picked));
    } catch {
      /* private mode */
    }
  }, [picked, rememberWs]);

  // The modifier printed on the footer keycaps: what is on the keycap.
  const modLabel =
    typeof navigator === 'undefined' || /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
      ? '⌘'
      : 'Ctrl';

  const toggleWs = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));

  const showResults = !cmdOnly && q.trim() !== '' && results.length > 0;
  const showCmdLabel = !cmdOnly && q.trim() !== '' && items.some((i) => i.kind === 'command');
  // Workspace rows render in their own leading section, mirroring nav order.
  const isWsRow = (c: PaletteCommand & { aliases: string[] }) => c.id.startsWith('ws:');
  const wsRows = (cmdOnly ? matchedCmds : q.trim() === '' ? allCmds : matchedCmds).filter(isWsRow);
  const regCmds = cmdOnly
    ? matchedCmds.filter((c) => !isWsRow(c))
    : q.trim() === ''
      ? allCmds.filter((c) => !isWsRow(c))
      : matchedCmds.filter((c) => !isWsRow(c)).slice(0, 5);

  // Shared by both placements below: on a typed query it leads the list, on
  // an empty one it follows recents (see the two call sites).
  const wsSection = wsRows.length > 0 && (
    <>
      <div className="search-section-label">{t('Workspaces')}</div>
      {wsRows.map((c) => {
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
            </span>
          </button>
        );
      })}
    </>
  );

  return (
    <Portal>
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={'search-modal' + (showPreview ? ' has-preview' : '')} onKeyDown={onKey}>
        <div className="search-topbar">
          <input
            ref={inputRef}
            className="search-input"
            placeholder={t('Search all pages…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className={'search-icon-btn' + (showPreview ? ' is-on' : '')}
            onClick={togglePreview}
            title={t('Preview')}
            aria-label={t('Preview')}
          >
            <PanelRight size={17} />
          </button>
        </div>
        <div className="search-body">
        <div className="search-main">
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
            {q.trim() !== '' && wsSection}
            {showResults &&
              results.map((r) => {
                const idx = items.findIndex((i) => (i.kind === 'result' || i.kind === 'recent') && i.r.id === r.id);
                const context = resultContext(r, workspaces);
                return (
                  <button
                    key={r.id}
                    className={'search-result' + (idx === sel ? ' selected' : '')}
                    onMouseEnter={() => idx >= 0 && setSel(idx)}
                    onClick={(e) => openRowClick(e, r.id)}
                    onAuxClick={(e) => openPageAux(e, r.id, { onNavigate, onOpenInNewTab })}
                  >
                    <span className="result-icon"><PageIcon icon={r.icon} size={16} fallback="📄" /></span>
                    <span className="result-body">
                      <span className="result-title">{r.title || t('Untitled')}</span>
                      {context && <span className="result-context">{context}</span>}
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
                      onClick={(e) => openRowClick(e, r.id)}
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
            {q.trim() === '' && !cmdOnly && wsSection}
            {(cmdOnly || showCmdLabel || (q.trim() === '' && !cmdOnly)) && regCmds.length > 0 && (
              <>
                <div className="search-section-label">{t('Commands')}</div>
                {regCmds.map((c) => {
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
        {showPreview && (
          <div className="search-preview">
            <div className="search-preview-head">
              <button
                type="button"
                className="search-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  if (previewId) (onOpenInNewTab ?? onNavigate)(previewId);
                }}
                disabled={!previewId}
                title={t('Open in new tab')}
                aria-label={t('Open in new tab')}
              >
                <ExternalLink size={15} />
              </button>
            </div>
            <div
              className="search-preview-body"
              onClick={(e) => {
                // Editor chrome and links answer for themselves; a click on
                // anything else opens the previewed page (see openPreview).
                const el = e.target as Element | null;
                if (el?.closest?.('button, a, input, select, textarea')) return;
                openPreview();
              }}
              title={previewId ? t('Open in new tab') : undefined}
              role={previewId ? 'button' : undefined}
              tabIndex={-1}
            >
              {previewPageId && (
                <Editor
                  key={previewPageId}
                  pageId={previewPageId}
                  pagesById={pagesById}
                  user={user}
                  theme={theme}
                  canEdit={false}
                  favorite={favorites.includes(previewPageId)}
                  tagColors={tagColors}
                  onSetTagColor={onSetTagColor}
                  onMenu={onMenu}
                  onToggleFavorite={onToggleFavorite}
                  onMetaChange={onMetaChange}
                  onMissing={(id) => onMissing(id)}
                  onNavigate={(id) => {
                    if (id) onNavigate(id);
                  }}
                  onOpenInNewTab={(id) => (onOpenInNewTab ?? onNavigate)(id)}
                  onCreatePage={onCreatePage}
                  onTrash={onTrash}
                  onPagesChanged={onPagesChanged}
                  regionId="search-preview"
                  primary={false}
                />
              )}
            </div>
          </div>
        )}
        </div>
      <div className="search-footer">
        <button
          type="button"
          className="search-footer-btn"
          onClick={() => previewId && (onOpenInNewTab ?? onNavigate)(previewId)}
          disabled={!previewId}
        >
          <span className="search-footer-key">{modLabel}</span>
          <span className="search-footer-key">↵</span> {t('Open in new tab')}
        </button>
        {workspaces.length > 1 && (
          <span className="search-footer-hint">
            <span className="search-footer-key">←</span>
            <span className="search-footer-key">→</span> {t('Workspaces')}
          </span>
        )}
        <div className="search-settings">
          {settingsOpen && (
            <div className="search-settings-pop">
              <label>
                <input type="checkbox" checked={rememberWs} onChange={toggleRememberWs} />
                {t('Remember workspace filter')}
              </label>
              <label>
                <input type="checkbox" checked={previewNewTab} onChange={togglePreviewNewTab} />
                {t('Always open in new tab')}
              </label>
            </div>
          )}
          <button
            type="button"
            className={'search-icon-btn' + (settingsOpen ? ' is-on' : '')}
            onClick={() => setSettingsOpen((v) => !v)}
            title={t('Search settings')}
            aria-label={t('Search settings')}
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
      </div>
      </div>
    </div>
    </Portal>
  );
}
