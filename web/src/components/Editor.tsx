import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from '@blocknote/react';
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { de as coreDe, en as coreEn, ru as coreRu } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { api, ApiError, materializeQuery } from '../api';
import * as Y from 'yjs';
import { clearJournal, dropYDoc, getPage as getCachedPage, putPage as putCachedPage, getYDoc, putYDoc } from '../offlineCache';
import { enqueue, isOfflineError, isTempId, newTempId, savePageUpdate } from '../outbox';
import {
  activeViewOf,
  canRedo,
  canUndo,
  getDocUndoState,
  setDocUndoState as writeDocUndoState,
} from '../viewUndo';
import { useOnline } from '../useOnline';
import { toast } from '../toast';
import { workflowBlockReason, planStatusMove, postMoveComment } from '../workflow';
import type { Backlink, CollectionConfig, Page, PageMeta, PropOption, User, Workspace } from '../types';
import { SaltProvider } from '../collab';
import { plural, t } from '../i18n';
import { formatDay } from '../format';
import { blockedByMap, dayNum, depListOf, isoDay, nextWorkday, prevWorkday, shiftTarget, type DepNode } from '../depUtils';
import PropertyValue from './PropertyValue';
import { saltSchema } from '../pageLink';
import AnchoredMenu from './AnchoredMenu';
import IconPicker from './IconPicker';
import { PageIcon } from '../pageIcon';
import { BlockContext } from '../blockContext';
import { exitsDown, exitsStart, focusedKey, focusItem, focusKey, focusRegion, navItem, nothingBefore, useNavRegion } from '../nav';
import { openPage, openPageAux, type PageOpeners } from '../pageOpen';
import { readPageScroll, writePageScroll } from '../pageUiState';
import { useShortcut } from '../keys';
import CollectionView from './CollectionView';
import PageShares from './PageShares';
import { HistoryModal } from './PageHistory';
import CommentsPanel, {
  COMMENTS_CHANGED,
  commentsPanelOpen,
  initials,
  setCommentsPanelOpen,
} from './CommentsPanel';
import NoteTrail from './NoteTrail';
import { FilePreview, isPreviewable } from './FilePreview';
import StructurePanel, { structurePanelOpen, setStructurePanelOpen } from './StructurePanel';
import { AgentPresence } from './AgentBadge';
import { usePeers, setPeers, clearPeers } from '../presence';
import { tagColorClass, TAG_PALETTE } from '../tags';
import { collectTags, suggestTags } from '../tagSuggest';
import { modalOpen, useMenuDismiss } from '../modal';
import { Menu, Star, Lock, LockOpen, Globe, MessageSquare, History, MoreHorizontal, Printer, FileCode, FileText, Upload, AlignLeft, Check, Image as ImageIcon, Smile, PanelRight, Link2, Trash2, FilePlus2, Columns2, Workflow, ClipboardList, ChevronsRight, Maximize2, SquareArrowOutUpRight, Pin, Undo2, Redo2, Copy } from 'lucide-react';
import { blockTypeFor, carriesExternalFiles } from '../dropFiles';

export interface EditorProps {
  pageId: string;
  pagesById: Map<string, PageMeta>;
  user: User;
  theme: 'light' | 'dark';
  canEdit: boolean;
  favorite: boolean;
  tagColors: Record<string, string>;
  onSetTagColor: (tag: string, color: string) => void;
  onMenu: () => void;
  onToggleFavorite: (id: string) => void;
  onMetaChange: (id: string, patch: Partial<PageMeta>) => void;
  onMissing: (id: string) => void;
  onNavigate: (id: string | null) => void;
  onOpenInNewTab: (id: string) => void;
  onCreatePage: (parentId: string | null, type?: 'doc' | 'collection') => void;
  // Deleting was reachable from the sidebar tree only. A database ROW — and any
  // page filed under one — never appears there as a tree item, so nothing in the
  // interface could throw it away: the row menu offers ＋ alone, the board card's
  // ⋯ only moves between columns, and this menu had no entry. The page menu is
  // the one menu every page has, so it is the honest place for it.
  onTrash: (id: string) => void;
  onDuplicate?: (id: string) => void | Promise<void>;
  onPagesChanged: () => void;
  currentWs?: string;
  workspaces?: Workspace[];
  onSelectWorkspace?: (id: string) => void;
  // Side peek chrome (see PeekPanel): when present, the panel controls sit
  // inline at the head of this topbar instead of on a bar of their own, and
  // the structure and favorite buttons move into the ⋯ menu — a narrow panel
  // has no room for a full desktop topbar.
  onPeekClose?: () => void;
  onPeekOpenFull?: (id: string) => void;
  /** Pinned: nothing hides the panel but its own close button. */
  peekPinned?: boolean;
  onPeekPin?: () => void;
  // Which keyboard-navigation region this editor owns. The main view is
  // 'content'; a second mounted editor (the side peek) takes another id, or
  // the two would register the same region and the later mount would steal
  // the earlier one's arrows — and keep them after it unmounts.
  regionId?: string;
  // Which editor answers focus-free shortcuts ('c' for comments) when the
  // focus sits outside every editor. The main view keeps the historic
  // behaviour; the peek answers only with the focus inside itself.
  primary?: boolean;
  // A brand-new page is a page you are about to name: the title takes the caret
  // (and is selected, so typing replaces the placeholder).
  focusTitleOnMount?: boolean;
}

export default function Editor(props: EditorProps) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offlineCopy, setOfflineCopy] = useState(false);
  const online = useOnline();
  const [nonce, setNonce] = useState(0);
  const regionId = props.regionId ?? 'content';
  const primary = props.primary ?? true;
  // The panel is a reading preference, not a property of the page: it stays
  // put while you move through the workspace, like the comment column's.
  const [structureOpen, setStructureOpen] = useState(structurePanelOpen);
  // Comments now live in a panel beside the document rather than at its foot —
  // his colleagues work in them all day and reported the old shape as awkward:
  // at the very bottom, and two lines to write in.
  const [commentsOpen, setCommentsOpen] = useState(commentsPanelOpen);

  // Both panels occupy the same strip on the right, so opening one closes the
  // other. Sharing the width would leave two columns too narrow to be either.
  const showStructure = (on: boolean) => {
    setStructureOpen(on);
    setStructurePanelOpen(on);
    if (on) {
      arrive();
      setCommentsOpen(false);
      setCommentsPanelOpen(false);
    }
  };
  const showComments = (on: boolean) => {
    setCommentsOpen(on);
    setCommentsPanelOpen(on);
    if (on) {
      arrive();
      setStructureOpen(false);
      setStructurePanelOpen(false);
    }
  };
  const toggleStructure = () => showStructure(!structureOpen);

  // A panel the reader just opened slides in. One that is simply still open
  // when the next page loads does not, or every click in the tree would set
  // it moving again, so the flag lives here, above the page that remounts.
  const [arriving, setArriving] = useState(false);
  const arriveTimer = useRef(0);
  const arrive = () => {
    setArriving(true);
    window.clearTimeout(arriveTimer.current);
    arriveTimer.current = window.setTimeout(() => setArriving(false), 400);
  };
  useEffect(() => () => window.clearTimeout(arriveTimer.current), []);

  // Where the window leaves the document too little room beside a panel (a
  // sidebar, the notes column and a panel side by side), the panel floats over
  // the text instead: squeezed, the title had come out one letter per line.
  // 340 to 460 mirrors --panel-w in styles.css; 440 is the narrowest column
  // that still reads as text.
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  // Same rule as the other single letters (see App.tsx): only while nothing is
  // being typed. A collection has no comment panel, so there it stays a letter.
  //
  // With two editors mounted (main + side peek) a focus-free shortcut must know
  // whose it is: the editor holding the focus answers, and with the focus
  // outside every editor the primary one keeps the historic behaviour.
  const ownsFocus = () => {
    const ae = document.activeElement as Element | null;
    if (pageEl && ae && pageEl.contains(ae)) return true;
    if (ae && ae.closest('.editor-page')) return false;
    return primary;
  };
  useShortcut({
    id: 'comments.toggle',
    keys: ['c'],
    when: () => !!page && page.type !== 'collection' && ownsFocus(),
    label: () => t('Comments'),
    group: () => t('Page'),
    run: () => {
      if (modalOpen()) return false;
      showComments(!commentsOpen);
    },
  });
  useEffect(() => {
    if (!pageEl) return;
    const ro = new ResizeObserver(([entry]) => {
      const panel = Math.min(460, Math.max(340, window.innerWidth * 0.26));
      setNarrow(entry.contentRect.width - panel < 440);
    });
    ro.observe(pageEl);
    return () => ro.disconnect();
  }, [pageEl]);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setError(null);
    setOfflineCopy(false);
    api
      .getPage(props.pageId)
      .then((p) => {
        if (!alive) return;
        setPage(p);
        void putCachedPage(p);
      })
      .catch((e: Error) => {
        // Offline with a snapshot: render the last seen copy instead of an
        // error. Edits still merge through the CRDT layer on reconnect.
        void getCachedPage(props.pageId).then((cached) => {
          if (!alive) return;
          if (cached) {
            setPage(cached);
            setOfflineCopy(true);
          } else {
            setError(e.message);
          }
        });
      });
    return () => {
      alive = false;
    };
  }, [props.pageId, nonce]);

  if (error) {
    return (
      <div className="editor-error">
        <p>{t('This page could not be loaded.')}</p>
        <button className="btn" onClick={() => props.onMissing(props.pageId)}>
          {t('Back to workspace')}
        </button>
      </div>
    );
  }
  if (!page) return <div className="editor-loading" />;

  // A database carries no comments — its ROWS do, and each of those is a page
  // with its own panel. Suppressing the panel alone was not enough: the button
  // stayed, which is a promise the page cannot keep, and the column it holds
  // open stayed with it, so the table rendered 340px narrow beside nothing.
  const canComment = page.type !== 'collection';

  // The content renders INSIDE PageHeader's .page-body scroller so cover,
  // title and content scroll away together (only the topbar stays fixed).
  return (
    <div
      ref={setPageEl}
      className={
        'editor-page' +
        (structureOpen || (commentsOpen && canComment) ? ' with-structure' : '') +
        (narrow ? ' is-narrow' : '') +
        (arriving ? ' panel-arriving' : '')
      }
    >
      {(offlineCopy || !online) && page ? (
        <div className="offline-banner" role="status">
          {t('Offline copy — changes will sync when the connection is back')}
        </div>
      ) : null}
      <PageHeader
        page={page}
        {...props}
        regionId={regionId}
        structureOpen={structureOpen}
        onToggleStructure={toggleStructure}
        commentsOpen={commentsOpen}
        onToggleComments={showComments}
        onLocalMeta={(patch) => setPage((p) => (p ? { ...p, ...patch } : p))}
      >
        {page.type === 'collection' ? (
          <CollectionView
            key={page.id}
            collectionId={page.id}
            pages={props.pagesById}
            tagColors={props.tagColors}
            onNavigate={props.onNavigate}
            onOpenInNewTab={props.onOpenInNewTab}
            onPagesChanged={props.onPagesChanged}
          />
        ) : (
          <CollabEditor
            // nonce remounts the whole collaboration stack after a
            // server-side reset, so the tab re-seeds from the rewrite
            // instead of sitting on (and saving from) the stale doc.
            key={`${page.id}:${nonce}`}
            regionId={regionId}
            structureOpen={structureOpen}
            page={page}
            user={props.user}
            theme={props.theme}
            canEdit={props.canEdit}
            pagesById={props.pagesById}
            tagColors={props.tagColors}
            onNavigate={props.onNavigate}
            onOpenInNewTab={props.onOpenInNewTab}
            onCreatePage={props.onCreatePage}
            onPagesChanged={props.onPagesChanged}
            onReset={() => {
              // The server replaced the document under us (restore, agent
              // rewrite, import): our in-flight edits lost to the replacement.
              // The state before it survives as a revision — point there.
              // The offline journal and snapshot die with it: replaying them
              // onto the new document would resurrect exactly what was
              // replaced.
              void clearJournal(props.pageId);
              void dropYDoc(props.pageId);
              toast.warning(t('This page was replaced on the server. Open Version history to recover your text.'));
              setNonce((n) => n + 1);
            }}
          />
        )}
      </PageHeader>
      {commentsOpen && canComment && (
        <CommentsPanel
          pageId={page.id}
          myUserId={props.user.id}
          open
          onClose={() => showComments(false)}
        />
      )}
      {structureOpen && (
        <StructurePanel
          pageId={page.id}
          isCollection={page.type === 'collection'}
          pagesById={props.pagesById}
          onNavigate={props.onNavigate}
          onOpenInNewTab={props.onOpenInNewTab}
          onClose={toggleStructure}
        />
      )}
    </div>
  );
}

// ---- shared header (breadcrumbs, title, icon) ----

const COVER_GRADIENTS = [
  // Light → dark (left → right): the page icon docks at the LEFT edge, so the
  // pale end sits behind it and keeps emoji/dark icons readable.
  'gradient:linear-gradient(120deg,#4fa872,#2f7d4f)',
  'gradient:linear-gradient(120deg,#6aa9e0,#3b6fb5)',
  'gradient:linear-gradient(120deg,#e0c56a,#b58a3b)',
  'gradient:linear-gradient(120deg,#b07de0,#7d4fb0)',
  'gradient:linear-gradient(120deg,#e0846a,#c4554d)',
  'gradient:linear-gradient(120deg,#6ad0d0,#3ba0a8)',
  // W96: more choice — soft two- and three-tone blends (aurora, sunset, sea),
  // still light to dark so the page emoji on the left docks legibly. On the
  // server side validCover lets any pure gradient through.
  'gradient:linear-gradient(120deg,#ffd3a5,#fd6585)',
  'gradient:linear-gradient(120deg,#a8edea,#5b86e5)',
  'gradient:linear-gradient(120deg,#f6d365,#fda085)',
  'gradient:linear-gradient(120deg,#d4fc79,#4a934a)',
  'gradient:linear-gradient(120deg,#e0c3fc,#8e63c9)',
  'gradient:linear-gradient(120deg,#f5efe6,#b8a389)',
  'gradient:linear-gradient(120deg,#fbc2eb,#a18cd1)',
  'gradient:linear-gradient(120deg,#fddb92,#d1858c)',
  'gradient:linear-gradient(120deg,#9be2d5,#2c7a7b)',
  'gradient:linear-gradient(120deg,#c9d6ff,#5c6bc0)',
  'gradient:linear-gradient(135deg,#ffecd2,#fcb69f 55%,#e0846a)',
  'gradient:linear-gradient(135deg,#a1c4fd,#c2e9fb 45%,#6aa9e0)',
  // Saturated, and on purpose: everything above is a soft blend, so a page that
  // wants to shout had nothing to reach for. The site's own beam colours.
  'gradient:linear-gradient(120deg,#ff2d60,#ff8a2d 25%,#ffd12d 45%,#22c55e 62%,#3b82f6 80%,#9333ea)',
  'gradient:linear-gradient(120deg,#22c55e,#3b82f6 55%,#9333ea)',
  'gradient:linear-gradient(120deg,#ffd12d,#ff8a2d 45%,#ff2d60)',
  'gradient:linear-gradient(120deg,#22d3ee,#3b82f6 50%,#9333ea)',
];

function coverStyle(cover: string): React.CSSProperties {
  if (cover.startsWith('gradient:')) return { background: cover.slice('gradient:'.length) };
  return { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' };
}

// A function, not a constant: a constant would resolve t() once at import time
// and keep whatever language happened to be active then.
const tagColorLabel = (c: string): string =>
  ({
    gray: t('Gray'),
    brown: t('Brown'),
    orange: t('Orange'),
    yellow: t('Yellow'),
    green: t('Green'),
    blue: t('Blue'),
    purple: t('Purple'),
    pink: t('Pink'),
    red: t('Red'),
  })[c] ?? c;

// A tag chip with a Notion-style colour picker: click the label to choose a
// colour (or "Default" = automatic), the × removes the tag.
function TagChip({
  tag,
  colors,
  canEdit,
  onRemove,
  onSetColor,
}: {
  tag: string;
  colors: Record<string, string>;
  canEdit: boolean;
  onRemove: () => void;
  onSetColor: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useMenuDismiss(open, wrapRef, () => setOpen(false));
  const current = colors[tag.toLowerCase()] || '';
  return (
    <span className={'page-tag ' + tagColorClass(tag, colors)} ref={wrapRef}>
      <button
        className="page-tag-label"
        onClick={() => canEdit && setOpen((o) => !o)}
        title={canEdit ? t('Change colour') : undefined}
      >
        #{tag}
      </button>
      {canEdit && (
        <button
          className="page-tag-x"
          title={t('Remove tag')}
          aria-label={t('Remove tag {tag}', { tag })}
          onClick={onRemove}
        >
          ×
        </button>
      )}
      {open && (
        <div className="menu tag-color-menu">
          <div className="menu-label">{t('Colour')}</div>
          <button
            className="tag-color-opt"
            onClick={() => {
              onSetColor('');
              setOpen(false);
            }}
          >
            <span className="tag-swatch tag-gray" />
            <span className="tag-color-name">{t('Default')}</span>
            {!current && <Check size={14} />}
          </button>
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              className="tag-color-opt"
              onClick={() => {
                onSetColor(c);
                setOpen(false);
              }}
            >
              <span className={'tag-swatch tag-' + c} />
              <span className="tag-color-name">{tagColorLabel(c)}</span>
              {current === c && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// RowProperties renders a database row's typed properties as a Notion-style
// panel under the title (label · value), so a row's page shows its Status,
// Priority, etc. as real fields — not as text dumped into the body. Shown only
// A blocked-row banner for the record editor: when sibling rows block this
// one and the dates overlap, say so and offer the same one-click shift as the
// timeline popover. Best-effort over the first 500 rows — a banner that misses
// on a giant database is better than a full-table scan on every open.
function BlockedBanner({
  pageId,
  parentId,
  liveProps,
  config,
  canEdit,
  onShift,
  onPagesChanged,
}: {
  pageId: string;
  parentId: string;
  liveProps: Record<string, unknown>;
  config: CollectionConfig;
  canEdit: boolean;
  onShift: (startProp: string, endProp: string, startIso: string, endIso: string | null) => void;
  onPagesChanged?: () => void;
}) {
  const [rows, setRows] = useState<{ id: string; title: string; props: Record<string, unknown> }[] | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [skipWeekendsOverride, setSkipWeekendsOverride] = useState<boolean | null>(null);
  const loadRows = useCallback(() => {
    api
      .collectionRows(parentId, { limit: 500 })
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [parentId]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api
      .collectionRows(parentId, { limit: 500 })
      .then((r) => alive && setRows(r.rows))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [parentId, pageId]);

  const schema = config.schema;
  const selfRels = schema.filter((p) => p.type === 'relation' && p.relationCollection === parentId);
  if (selfRels.length === 0 || rows === null) return null;
  const tlView = config.views.find((v) => v.type === 'timeline');
  const picked = tlView?.depProp && selfRels.some((p) => p.id === tlView.depProp) ? tlView.depProp : '';
  const effDep = picked || (selfRels.length === 1 ? selfRels[0].id : '');
  if (!effDep) return null;
  const dateIds = schema.filter((p) => p.type === 'date').map((p) => p.id);
  const startProp =
    tlView?.dateProp && dateIds.includes(tlView.dateProp) ? tlView.dateProp : (dateIds[0] ?? '');
  if (!startProp) return null;
  const endProp = tlView?.endDateProp && dateIds.includes(tlView.endDateProp) ? tlView.endDateProp : '';

  const toNode = (id: string, props: Record<string, unknown>, known: Set<string>): DepNode | null => {
    const sv = props[startProp];
    if (typeof sv !== 'string' || !sv) return null;
    const start = dayNum(sv);
    let end = start;
    if (endProp) {
      const ev = props[endProp];
      if (typeof ev === 'string' && ev) end = Math.max(start, dayNum(ev));
    }
    return { id, start, end, deps: depListOf(props, effDep, id, known) };
  };
  // Two passes: ids first (links only resolve against dated rows), then edges.
  const known = new Set<string>();
  const dated = new Map<string, { title: string; props: Record<string, unknown> }>();
  for (const r of rows) {
    const sv = r.props[startProp];
    if (typeof sv === 'string' && sv) {
      known.add(r.id);
      dated.set(r.id, r);
    }
  }
  const selfSv = liveProps[startProp];
  const selfDated = typeof selfSv === 'string' && !!selfSv;
  if (selfDated) known.add(pageId);
  const nodes: DepNode[] = [];
  for (const [id, r] of dated) {
    const n = toNode(id, r.props, known);
    if (n) nodes.push(n);
  }
  if (selfDated) {
    const n = toNode(pageId, liveProps, known);
    if (n) {
      const at = nodes.findIndex((x) => x.id === pageId);
      if (at >= 0) nodes[at] = n;
      else nodes.push(n);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const titles = new Map<string, string>();
  for (const r of rows) titles.set(r.id, r.title);
  const self = byId.get(pageId);
  if (!self) return null;
  const blockers = (blockedByMap(nodes).get(pageId) ?? [])
    .map((id) => byId.get(id)!)
    .filter((p) => p && self.start <= p.end);
  if (!blockers.length) return null;
  const skipWeekends = skipWeekendsOverride ?? (tlView?.tlSkipWeekends ?? false);
  const shiftDay = (d: number) => (skipWeekends ? nextWorkday(d) : d);
  const latest = Math.max(...blockers.map((p) => p.end));
  const rawTarget = shiftTarget(self, blockers);
  const target = rawTarget !== null ? shiftDay(rawTarget) : null;

  const onToggleSkipWeekends = async (checked: boolean) => {
    setSkipWeekendsOverride(checked);
    if (!config) return;
    const views = config.views.map((v) => {
      if (tlView && v.id === tlView.id) {
        return { ...v, tlSkipWeekends: checked };
      }
      return v;
    });
    try {
      await api.putCollection(parentId, { views });
    } catch {
      toast(t('Could not save settings'));
    }
  };

  return (
    <div className="dep-banner" role="status">
      <span className="dep-banner-ic">⚠</span>
      <div className="dep-banner-text">
        {t('Blocked by {names} until {d}', {
          names: blockers.map((p) => titles.get(p.id) ?? t('Untitled')).join(', '),
          d: formatDay(isoDay(latest), 'dayMonth'),
        })}
      </div>
      {target !== null && canEdit && (
        <div className="dep-banner-actions">
          <button
            className="btn-sm primary"
            onClick={() =>
              onShift(startProp, endProp, isoDay(target), endProp ? isoDay(target + (self.end - self.start)) : null)
            }
          >
            {t('Shift to {d}, keep duration', { d: formatDay(isoDay(target), 'dayMonth') })}
          </button>
          <div className="tl-conflict-more-wrap">
            <button
              className="btn-sm"
              aria-label={t('More actions')}
              title={t('More actions')}
              onClick={(e) => {
                e.stopPropagation();
                setMoreOpen((o) => !o);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
            {moreOpen && (
              <>
                <div
                  className="fs-backdrop tl-conflict-sub-backdrop"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                  }}
                />
                <AnchoredMenu className="menu tl-conflict-sub-menu">
                  {blockers.map((b) => {
                    const dur = b.end - b.start;
                    const predTargetEnd = skipWeekends ? prevWorkday(self.start - 1) : self.start - 1;
                    const predTargetStart = predTargetEnd - dur;
                    return (
                      <button
                        key={'pred-' + b.id}
                        className="menu-item"
                        onClick={async () => {
                          setMoreOpen(false);
                          const patch: Record<string, string> = {
                            [startProp]: isoDay(predTargetStart),
                            ...(endProp ? { [endProp]: isoDay(predTargetEnd) } : {}),
                          };
                          await api.updatePage(b.id, { propsPatch: patch });
                          loadRows();
                          onPagesChanged?.();
                        }}
                      >
                        {blockers.length === 1
                          ? t('Shift blocker to finish on {d}', {
                              d: formatDay(isoDay(predTargetEnd), 'dayMonth'),
                            })
                          : t('Shift “{title}” to finish on {d}', {
                              title: titles.get(b.id) || t('Untitled'),
                              d: formatDay(isoDay(predTargetEnd), 'dayMonth'),
                            })}
                      </button>
                    );
                  })}
                  <button
                    className="menu-item"
                    onClick={async () => {
                      setMoreOpen(false);
                      const delta = target - self.start;
                      if (delta <= 0) return;
                      onShift(startProp, endProp, isoDay(target), endProp ? isoDay(target + (self.end - self.start)) : null);
                      const chain = new Set<string>();
                      const queue = [pageId];
                      while (queue.length) {
                        const cur = queue.shift()!;
                        const it = byId.get(cur);
                        for (const next of it?.deps ?? []) {
                          if (!chain.has(next)) {
                            chain.add(next);
                            queue.push(next);
                          }
                        }
                      }
                      for (const succId of chain) {
                        const it = byId.get(succId);
                        if (!it) continue;
                        const itDur = it.end - it.start;
                        const newStart = it.start + delta;
                        const patch: Record<string, string> = {
                          [startProp]: isoDay(newStart),
                          ...(endProp ? { [endProp]: isoDay(newStart + itDur) } : {}),
                        };
                        await api.updatePage(succId, { propsPatch: patch });
                      }
                      loadRows();
                      onPagesChanged?.();
                    }}
                  >
                    {t('Shift task and chain forward')}
                  </button>
                  <div className="menu-sep" />
                  {blockers.map((b) => (
                    <button
                      key={'unlink-' + b.id}
                      className="menu-item danger"
                      onClick={async () => {
                        setMoreOpen(false);
                        const cur = b.deps.filter((id) => id !== pageId);
                        await api.updatePage(b.id, { propsPatch: { [effDep]: cur } });
                        loadRows();
                        onPagesChanged?.();
                      }}
                    >
                      {blockers.length === 1
                        ? t('Remove dependency')
                        : t('Remove dependency with “{title}”', {
                            title: titles.get(b.id) || t('Untitled'),
                          })}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <label className="tl-settings-row tl-checkbox-row">
                    <span>{t('Skip weekends')}</span>
                    <input
                      type="checkbox"
                      checked={!!skipWeekends}
                      onChange={(e) => void onToggleSkipWeekends(e.target.checked)}
                    />
                  </label>
                  <div className="tl-menu-hint">
                    {t("Shifting a task out of its blockers' way lands on a working day.")}
                  </div>
                </AnchoredMenu>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// when the page is a child of a collection. Reuses the same PropertyValue cells
// (and inline option editing) as the table/board.
function RowProperties({
  pageId,
  parentId,
  initialProps,
  canEdit,
  onOpen,
  openers,
  onPagesChanged,
}: {
  pageId: string;
  parentId: string;
  initialProps: Record<string, unknown>;
  canEdit: boolean;
  onOpen?: (id: string) => void;
  openers?: PageOpeners;
  onPagesChanged?: () => void;
}) {
  const [config, setConfig] = useState<CollectionConfig | null>(null);
  const [props, setProps] = useState<Record<string, unknown>>(initialProps ?? {});

  useEffect(() => {
    setProps(initialProps ?? {});
  }, [pageId, initialProps]);

  useEffect(() => {
    let alive = true;
    api
      .getCollection(parentId)
      .then((c) => alive && setConfig(c))
      .catch(() => { });
    return () => {
      alive = false;
    };
  }, [parentId]);

  if (!config || config.schema.length === 0) return null;

  const setProp = async (propId: string, value: unknown) => {
    const wf = config?.workflow;
    let patch: Record<string, unknown> = { [propId]: value };
    if (wf && wf.statusPropId === propId) {
      const cur = props[propId];
      const from = Array.isArray(cur) ? (cur[0] as string) ?? '' : (cur as string) ?? '';
      const rawTo = value as string | string[];
      const to = Array.isArray(rawTo) ? (rawTo[0] as string) ?? '' : (rawTo as string) ?? '';
      const reason = workflowBlockReason(wf, config.schema, props, from, to);
      if (reason) {
        toast.warning(reason.message);
        return;
      }
      const optName =
        config.schema.find((p) => p.id === propId)?.options?.find((o) => o.id === to)?.name ?? to;
      const plan = await planStatusMove(wf, config.schema, pageId, props, from, to, optName);
      if (!plan) return;
      patch = { ...patch, ...plan.patch };
      if (plan.comment) void postMoveComment(pageId, plan.comment);
    }
    setProps((p) => ({ ...p, ...patch }));
    try {
      await api.updatePage(pageId, { propsPatch: patch });
    } catch (e) {
      if (!(await savePageUpdate(pageId, { propsPatch: patch }, { label: t('Property') }))) {
        toast(t('Property not saved'));
      }
    }
  };
  const setOptions = async (propId: string, options: PropOption[]) => {
    const next: CollectionConfig = {
      ...config,
      schema: config.schema.map((p) => (p.id === propId ? { ...p, options } : p)),
    };
    setConfig(next);
    try {
      // The schema alone: this copy of the views is as old as the open page.
      await api.putCollection(parentId, { schema: next.schema });
    } catch {
      toast(t('Options not saved'));
    }
  };

  return (
    <>
      <BlockedBanner
        pageId={pageId}
        parentId={parentId}
        liveProps={props}
        config={config}
        canEdit={canEdit}
        onPagesChanged={onPagesChanged}
        onShift={(sp, ep, sIso, eIso) => {
          void setProp(sp, sIso);
          if (ep && eIso) void setProp(ep, eIso);
        }}
      />
      <div className="row-props">
        {config.schema.map((p) => (
          <div key={p.id} className="row-prop">
            <div className="row-prop-label" title={p.name}>
              {p.name}
            </div>
            <div className="row-prop-value">
              <PropertyValue
                def={p}
                value={props[p.id]}
                onChange={canEdit ? (v) => setProp(p.id, v) : undefined}
                onOptionsChange={canEdit ? (o) => setOptions(p.id, o) : undefined}
                readOnly={!canEdit}
                onOpen={onOpen}
                openers={openers}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// The expiry select offers fixed buckets; map a stored expires_at back onto
// the nearest one so the menu reflects the live link. Anything custom reads
// as the closest bucket — picking it again keeps roughly the same expiry.
function expiryToDays(expiresAt?: string): number {
  if (!expiresAt) return 0;
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const days = ms / 86400000;
  let best = 0;
  let bestDiff = Infinity;
  for (const b of [0, 1, 7, 30]) {
    const d = Math.abs(days - b);
    if (d < bestDiff) {
      bestDiff = d;
      best = b;
    }
  }
  return best;
}

interface PageTitleContextType {
  title: string;
  setTitleAndSave: (newTitle: string) => void;
  titleRef: React.RefObject<HTMLTextAreaElement | null>;
  registerFocusBodyStart: (fn: () => void) => void;
}
const PageTitleContext = createContext<PageTitleContextType | null>(null);

function PageHeader({
  page,
  pageId,
  favorite,
  user,
  canEdit,
  tagColors,
  onSetTagColor,
  onMenu,
  onToggleFavorite,
  onMetaChange,
  onNavigate,
  onOpenInNewTab,
  onTrash,
  onDuplicate,
  onLocalMeta,
  onPagesChanged,
  pagesById,
  regionId,
  focusTitleOnMount,
  onPeekClose,
  onPeekOpenFull,
  peekPinned,
  onPeekPin,
  structureOpen,
  onToggleStructure,
  commentsOpen,
  onToggleComments,
  currentWs,
  workspaces,
  onSelectWorkspace,
  children,
}: EditorProps & {
  page: Page;
  onLocalMeta: (patch: Partial<PageMeta>) => void;
  regionId: string;
  onPeekClose?: () => void;
  onPeekOpenFull?: (id: string) => void;
  /** Pinned: nothing hides the panel but its own close button. */
  peekPinned?: boolean;
  onPeekPin?: () => void;
  structureOpen: boolean;
  onToggleStructure: () => void;
  commentsOpen: boolean;
  onToggleComments: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [title, setTitle] = useState(page.title);
  const focusBodyStartRef = useRef<(() => void) | null>(null);
  const registerFocusBodyStart = useCallback((fn: () => void) => {
    focusBodyStartRef.current = fn;
  }, []);
  const focusBodyStart = () => {
    focusKey(regionId, 'body');
    focusBodyStartRef.current?.();
  };
  const [tags, setTags] = useState<string[]>(page.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [tagSuggestOpen, setTagSuggestOpen] = useState(false);
  const [tagSel, setTagSel] = useState(0);
  const [description, setDescription] = useState(page.description ?? '');
  const [showDesc, setShowDesc] = useState(!!page.description);
  const importInput = useRef<HTMLInputElement>(null);
  const [icon, setIcon] = useState(page.icon);
  const [cover, setCover] = useState(page.cover);
  const [visibility, setVisibility] = useState(page.visibility);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // The server's shared flag survives navigation; the local states do not, so
  // both are reset here. shareOff masks a just-revoked link the list still
  // reports until it reloads.
  const [shareOff, setShareOff] = useState(false);
  useEffect(() => {
    setShareUrl(null);
    setShareOff(false);
    setShareOpen(false);
    setShareExpiry(0);
    setSharePassword('');
    setShareHasPassword(false);
    setReadShared(false);
    setFormShared(false);
    setLastPassword('');
  }, [pageId]);
  const isShared = shareUrl != null || (!!page.shared && !shareOff);
  const [shareExpiry, setShareExpiry] = useState(0); // days; 0 = never
  const [sharePassword, setSharePassword] = useState('');
  const [shareHasPassword, setShareHasPassword] = useState(false);
  // Read-share and form-share are independent links; the dialog tracks them
  // apart so a live form alone still offers the read share instead of the
  // "link active, no URL" dead end. lastPassword is the raw password as last
  // applied here — the only moment it exists — for the ?pw= copy below.
  const [readShared, setReadShared] = useState(false);
  const [formShared, setFormShared] = useState(false);
  const [lastPassword, setLastPassword] = useState('');
  const isCollection = page.type === 'collection';
  // Collection share settings: which views the public link shows (null = all)
  // and whether readers may open rows. Loaded lazily with the share menu.
  const [shareViewsList, setShareViewsList] = useState<{ id: string; name: string }[]>([]);
  const [shareAllowed, setShareAllowed] = useState<string[] | null>(null);
  const [shareAllowDetail, setShareAllowDetail] = useState(false);
  useEffect(() => {
    setShareViewsList([]);
    setShareAllowed(null);
    setShareAllowDetail(false);
  }, [pageId]);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Undo/redo for the ⋯ menu below: the collection's session stacks (see
  // viewUndo) or the document's BlockNote history, whichever this page is.
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });
  const [docUndoState, setDocUndoState] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    if (!isCollection || !overflowOpen) return;
    const refresh = () => {
      const vid = activeViewOf(page.id);
      setUndoState(
        vid ? { canUndo: canUndo(vid), canRedo: canRedo(vid) } : { canUndo: false, canRedo: false },
      );
    };
    const onState = (e: Event) => {
      const vid = (e as CustomEvent<{ viewId?: string }>).detail?.viewId;
      if (vid && vid === activeViewOf(page.id)) refresh();
    };
    refresh();
    window.addEventListener('salt:undo-state', onState);
    return () => window.removeEventListener('salt:undo-state', onState);
  }, [page.id, isCollection, overflowOpen]);
  useEffect(() => {
    if (isCollection || !overflowOpen) return;
    const refresh = () => setDocUndoState(getDocUndoState(page.id, regionId));
    const onState = (e: Event) => {
      const d = (e as CustomEvent<{ pageId?: string; region?: string; canUndo?: boolean; canRedo?: boolean }>).detail;
      if (d && d.pageId === page.id && d.region === regionId) {
        refresh();
      }
    };
    refresh();
    window.addEventListener('salt:doc-undo-state', onState);
    return () => window.removeEventListener('salt:doc-undo-state', onState);
  }, [page.id, isCollection, regionId, overflowOpen]);
  const fireUndo = () => {
    setOverflowOpen(false);
    if (isCollection) {
      const vid = activeViewOf(page.id);
      if (vid) window.dispatchEvent(new CustomEvent('salt:undo-request', { detail: { viewId: vid } }));
    } else {
      window.dispatchEvent(new CustomEvent('salt:doc-undo', { detail: { pageId: page.id, region: regionId } }));
    }
  };
  const fireRedo = () => {
    setOverflowOpen(false);
    if (isCollection) {
      const vid = activeViewOf(page.id);
      if (vid) window.dispatchEvent(new CustomEvent('salt:redo-request', { detail: { viewId: vid } }));
    } else {
      window.dispatchEvent(new CustomEvent('salt:doc-redo', { detail: { pageId: page.id, region: regionId } }));
    }
  };
  const undoCtl = isCollection ? undoState : docUndoState;
  // Dropdowns must close on an outside click / Escape, not just mouse-leave.
  const shareWrapRef = useRef<HTMLDivElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const accessWrapRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(shareOpen, shareWrapRef, () => setShareOpen(false));
  useMenuDismiss(overflowOpen, overflowWrapRef, () => setOverflowOpen(false));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sharesOpen, setSharesOpen] = useState(false);
  // The access panel hangs off its topbar button like the share menu — same
  // outside-click/Escape dismissal, no modal overlay.
  useMenuDismiss(sharesOpen, accessWrapRef, () => setSharesOpen(false));
  const [openComments, setOpenComments] = useState(0);
  // Same rule as in Editor, and it has to be asked here too: this is where the
  // button, the menu entries and the count live.
  const canComment = page.type !== 'collection';
  const peers = usePeers(pageId);
  // The counter in the header should be right before anybody has scrolled
  // down — you should SEE that comments exist without going to look.
  useEffect(() => {
    if (!canComment) return;
    let alive = true;
    const count = () =>
      api
        .listComments(pageId)
        .then((l) => alive && setOpenComments(l.filter((c) => !c.resolvedAt).length))
        .catch(() => { });
    void count();
    // The panel says when it changed something. An event rather than a prop:
    // the count has to be right whether the panel is open or not, so the header
    // owns its own fetch and the panel only nudges it.
    window.addEventListener(COMMENTS_CHANGED, count);
    return () => {
      alive = false;
      window.removeEventListener(COMMENTS_CHANGED, count);
    };
  }, [pageId, canComment]);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingMeta = useRef<{ title?: string; icon?: string; cover?: string; tags?: string[]; description?: string }>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // The document as one region of two items, its title and its text — rendered
  // by two sibling components that share no state, which is exactly why this
  // belongs to nav.ts: it moves focus by document order and needs neither of
  // them to know about the other.
  //
  // whileTyping, because both items ARE text surfaces and the arrows would
  // otherwise never fire here. canLeave is what makes that survivable: the
  // keystroke goes back to the browser unless the caret sits at the very edge
  // it is trying to cross.
  useNavRegion({
    id: regionId,
    ref: bodyRef,
    scope: 'editor',
    prev: regionId === 'content' ? 'sidebar.tree' : undefined,
    whileTyping: true,
    canLeave: (el, dir) => {
      if (el === titleRef.current) {
        const ta = titleRef.current;
        const s = { start: ta.selectionStart, end: ta.selectionEnd, length: ta.value.length };
        if (dir === 'down') return exitsDown(s);
        // ← at the start of the title is how you get back to the sidebar,
        // without a mode or an Escape that would fight the editor's menus.
        if (dir === 'left') return exitsStart(s);
        return false;
      }
      if (el.dataset.navKey === 'body') {
        const surface = el.querySelector('[contenteditable="true"]');
        // Up leaves by the top of the text to the title. Left is handled by onCollapse.
        return !!surface && dir === 'up' && nothingBefore(surface);
      }
      return false;
    },
    onCollapse: (el, key) => {
      if (key === 'body') {
        const surface = el.querySelector('[contenteditable="true"]');
        if (surface && nothingBefore(surface)) {
          focusKey(regionId, 'title');
          const ta = titleRef.current;
          if (ta) {
            ta.focus();
            const len = ta.value.length;
            ta.setSelectionRange(len, len);
          }
          requestAnimationFrame(() => {
            const ta = titleRef.current;
            if (ta) {
              ta.focus();
              const len = ta.value.length;
              ta.setSelectionRange(len, len);
            }
          });
          return true;
        }
      }
      return false;
    },
    onExpand: (el, key) => {
      if (key === 'title') {
        const ta = titleRef.current;
        if (ta) {
          const s = { start: ta.selectionStart, end: ta.selectionEnd, length: ta.value.length };
          if (s.start === s.end && s.start === s.length) {
            focusBodyStart();
            return true;
          }
        }
      }
      return false;
    },
  });

  // Once per mount: a later re-render must not steal the caret back.
  const wantTitleFocus = useRef(!!focusTitleOnMount);
  // The peek's expand menu: a moment's hover rather than an instant one, so
  // passing over the button on the way to the close button does not open it.
  // Unpinning from the menu must not strand it open: the button it hangs off
  // changes meaning under it (back to the fullscreen arrow), so the menu goes
  // with the pin.
  const [peekMenuOpen, setPeekMenuOpen] = useState(false);
  const peekMenuTimer = useRef(0);
  const peekMenuEnter = () => {
    window.clearTimeout(peekMenuTimer.current);
    peekMenuTimer.current = window.setTimeout(() => setPeekMenuOpen(true), 450);
  };
  const peekMenuLeave = (e: React.MouseEvent) => {
    window.clearTimeout(peekMenuTimer.current);
    // The menu hangs a few pixels below the button, and a pointer travelling
    // to it crosses a strip that belongs to neither — leaving the wrap would
    // close the menu the instant the pointer aims at it diagonally. So the
    // way there stays open: while the pointer is inside the trapezoid from the
    // button's edges to the menu's edges, the menu lives, and it closes once
    // the pointer is outside both.
    const wrap = e.currentTarget as HTMLElement;
    const menu = wrap.querySelector('.peek-open-menu') as HTMLElement | null;
    if (menu) {
      const b = wrap.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;
      const gap = Math.max(1, m.top - b.bottom);
      if (y >= b.bottom && y <= m.bottom) {
        const k = Math.min(1, (y - b.bottom) / gap);
        const left = y <= m.top ? b.left + (m.left - b.left) * k : m.left;
        const right = y <= m.top ? b.right + (m.right - b.right) * k : m.right;
        if (x >= left && x <= right) {
          const watch = (ev: MouseEvent) => {
            const wb = wrap.getBoundingClientRect();
            const inside =
              ev.clientX >= Math.min(wb.left, m.left) - 4 &&
              ev.clientX <= Math.max(wb.right, m.right) + 4 &&
              ev.clientY >= wb.top &&
              ev.clientY <= m.bottom;
            if (menu.contains(ev.target as Node)) {
              document.removeEventListener('mousemove', watch);
              return;
            }
            if (!inside) {
              document.removeEventListener('mousemove', watch);
              setPeekMenuOpen(false);
            }
          };
          document.addEventListener('mousemove', watch);
          return;
        }
      }
    }
    setPeekMenuOpen(false);
  };
  useEffect(
    () => () => {
      window.clearTimeout(peekMenuTimer.current);
    },
    [],
  );

  // The caret for a page that has just been made. Waits for the title field to
  // exist, which is a render behind the page itself.
  useEffect(() => {
    if (!wantTitleFocus.current || !page) return;
    const el = titleRef.current;
    if (!el) return;
    wantTitleFocus.current = false;
    el.focus();
    el.select();
  }, [page]);

  // Grow the title to fit its text (any length wraps to as many lines as needed,
  // like Notion) — on every edit and whenever the page (and thus title) changes.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    };
    fit();
    // scrollHeight depends on the WIDTH. When the column gets narrower — the
    // window shrinks, the sidebar collapses — the title wraps onto more lines
    // without the text changing at all. Without measuring again the old height
    // stayed and the last line disappeared behind the buttons below it.
    //
    // What is observed is the PARENT, not the field itself: fit() changes the
    // height of the field, and changing an element inside its own callback
    // creates a loop — which the browser quietly switches off. That is exactly
    // what the first version failed on.
    const box = el.parentElement;
    if (!box) return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [title]);

  useEffect(() => {
    setTitle(page.title);
    setIcon(page.icon);
    setCover(page.cover);
    setVisibility(page.visibility);
  }, [page.title, page.icon, page.cover, page.visibility]);

  // Toggle a `scrolled` class on the page body (with hysteresis so it never
  // flaps) — CSS uses it to shrink the docked page icon once the collapsed
  // cover strip is pinned.
  //
  // The same listener remembers the scroll position per page (see
  // pageUiState): the Editor remounts on every document-tab switch, so without
  // this every return lands at the top.
  //
  // Only USER moves are remembered. After a restore the content keeps growing
  // (images, embeds, fonts), and the browser's scroll anchoring shifts scrollTop
  // to hold the text still — persisting that shift ratchets the position a
  // little lower on every reload. A gesture timestamp separates the two: wheel,
  // touch, keys and scrollbar drags count; restores, anchoring and content
  // growth do not.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let scrolled = false;
    let saveRaf = 0;
    let lastGesture = 0;
    const markGesture = () => {
      lastGesture = Date.now();
    };
    const maySave = () => Date.now() - lastGesture < 2000;
    const onScroll = () => {
      const s = el.scrollTop;
      if (!scrolled && s > 110) {
        scrolled = true;
        el.classList.add('scrolled');
      } else if (scrolled && s < 90) {
        scrolled = false;
        el.classList.remove('scrolled');
      }
      if (!maySave()) return;
      cancelAnimationFrame(saveRaf);
      saveRaf = requestAnimationFrame(() => {
        if (maySave()) writePageScroll(pageId, el.scrollTop);
      });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', markGesture, { passive: true });
    el.addEventListener('touchmove', markGesture, { passive: true });
    el.addEventListener('pointerdown', markGesture);
    el.addEventListener('keydown', markGesture);
    return () => {
      cancelAnimationFrame(saveRaf);
      // A switch made mid-glide keeps the last user position rather than the
      // one before it — but never an anchoring shift (no gesture, no save).
      if (maySave()) writePageScroll(pageId, el.scrollTop);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', markGesture);
      el.removeEventListener('touchmove', markGesture);
      el.removeEventListener('pointerdown', markGesture);
      el.removeEventListener('keydown', markGesture);
    };
  }, [pageId]);

  // Back where you were: restore the remembered scroll position. The content
  // (document blocks, collection rows) grows over several frames after the
  // mount, and setting scrollTop early clamps — so retry until the value
  // sticks or the budget runs out.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const saved = el && readPageScroll(pageId);
    if (!el || !saved) return;
    let tries = 60;
    let raf = 0;
    const restore = () => {
      el.scrollTop = saved.top;
      if (el.scrollTop < saved.top - 2 && --tries > 0) raf = requestAnimationFrame(restore);
    };
    raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [pageId]);

  const togglePrivate = () => {
    const next = visibility === 'private' ? 'workspace' : 'private';
    setVisibility(next);
    api.updatePage(pageId, { visibility: next }).catch((e) => {
      if (isTempId(pageId) || isOfflineError(e)) {
        void savePageUpdate(pageId, { visibility: next }, { label: t('Visibility') });
        return;
      }
      toast(t('Visibility not saved'));
    });
  };

  // The token itself is stored hashed server-side, so a minted URL cannot be
  // recovered — only remembered. The owner who minted it keeps it in this
  // browser; opening the menu must never mint silently, or every open would
  // kill the link somebody already sent.
  const shareUrlKey = `salt:share-url:${pageId}`;
  const readStoredUrl = (): string | null => {
    try {
      return localStorage.getItem(shareUrlKey);
    } catch {
      return null;
    }
  };
  const rememberUrl = (url: string) => {
    try {
      localStorage.setItem(shareUrlKey, url);
    } catch {
      // Private mode — the link simply will not survive a reload here.
    }
  };
  const forgetUrl = () => {
    try {
      localStorage.removeItem(shareUrlKey);
    } catch {
      // Nothing stored, nothing to forget.
    }
  };
  const displayUrl = shareUrl ?? readStoredUrl();

  const mintShare = async (days: number, password: string, allowed?: string[] | null, allowDetail?: boolean, rotated = false) => {
    try {
      const res = await api.sharePage(
        pageId,
        days,
        password,
        isCollection ? (allowed ?? shareAllowed ?? []) : [],
        isCollection ? (allowDetail ?? shareAllowDetail) : false,
      );
      // Absolute URL on the external domain when configured; else current origin.
      const url = res.url.startsWith('http') ? res.url : location.origin + res.url;
      setShareUrl(url);
      rememberUrl(url);
      setShareOff(false);
      setReadShared(true);
      setSharePassword('');
      setShareHasPassword(password !== '');
      setLastPassword(password);
      if (rotated) toast.warning(t('A new link was created — the old one no longer works'));
    } catch {
      toast(t('Sharing failed'));
    }
  };

  const loadShareSettings = async (): Promise<{ shared: boolean; allowed: string[] | null; detail: boolean }> => {
    let out = { shared: false, allowed: null as string[] | null, detail: false };
    try {
      const st = await api.shareStatus(pageId);
      if (st.shared) {
        out = {
          shared: true,
          allowed: st.allowedViews && st.allowedViews.length > 0 ? st.allowedViews : null,
          detail: !!st.allowDetail,
        };
        setReadShared(true);
        setShareAllowed(out.allowed);
        setShareAllowDetail(out.detail);
        setShareHasPassword(!!st.hasPassword);
        setShareExpiry(expiryToDays(st.expiresAt));
      } else {
        setReadShared(false);
      }
    } catch {
      // No live share yet — defaults stand.
    }
    if (isCollection) {
      try {
        const fs = await api.formShareStatus(pageId);
        setFormShared(fs.shared);
      } catch {
        // Form state unknown — the note below simply stays hidden.
      }
    }
    if (!isCollection) return out;
    try {
      const c = await api.getCollection(pageId);
      setShareViewsList(c.views.filter((v) => v.type !== 'form').map((v) => ({ id: v.id, name: v.name })));
    } catch {
      // Not a collection (any more) — the section stays hidden.
    }
    return out;
  };

  const openShare = async () => {
    setShareOpen((o) => !o);
    // Never mint here: minting replaces the token, so opening the menu must
    // only read. A fresh link is created by the explicit button below.
    await loadShareSettings();
  };

  const toggleShareView = async (viewId: string) => {
    const next = shareAllowed === null
      ? shareViewsList.filter((v) => v.id !== viewId).map((v) => v.id)
      : shareAllowed.includes(viewId)
        ? shareAllowed.filter((id) => id !== viewId)
        : [...shareAllowed, viewId];
    // Unchecking the last view would publish an empty collection — keep one.
    if (next.length === 0) {
      toast.warning(t('Keep at least one view shared'));
      return;
    }
    setShareAllowed(next.length >= shareViewsList.length ? null : next);
    try {
      await api.patchShare(pageId, { allowedViews: next });
    } catch {
      toast(t('Sharing failed'));
    }
  };

  const toggleShareDetail = async () => {
    const next = !shareAllowDetail;
    setShareAllowDetail(next);
    try {
      await api.patchShare(pageId, { allowDetail: next });
    } catch {
      toast(t('Sharing failed'));
    }
  };

  const changeExpiry = async (days: number) => {
    setShareExpiry(days);
    // In place: expiry is a column update, the token stays.
    try {
      await api.patchShare(pageId, { expiresInDays: days });
    } catch {
      toast(t('Sharing failed'));
    }
  };

  // The password lives in its own salted hash beside the token, so setting
  // or removing one keeps the link: PATCH in place, never a re-mint — and
  // skipped when there is nothing to change.
  const applyPassword = async () => {
    if (sharePassword === '' && !shareHasPassword) return;
    try {
      const res = await api.patchShare(pageId, { password: sharePassword });
      setSharePassword('');
      setShareHasPassword(!!res.hasPassword);
      setLastPassword(sharePassword);
    } catch {
      toast(t('Sharing failed'));
    }
  };

  // A direct-open link for a passworded share: the raw password exists only
  // in this sitting (it is stored hashed), so the button shows exactly while
  // there is one to embed — typed-but-unapplied, or just applied. Copying
  // applies a still-unapplied value first, so the copied address always
  // matches the live link instead of racing it.
  const pwForLink = sharePassword !== '' ? sharePassword : lastPassword;
  const copyPwLink = async () => {
    const url = displayUrl;
    if (!url) return;
    let pw = lastPassword;
    if (sharePassword !== '') {
      try {
        const res = await api.patchShare(pageId, { password: sharePassword });
        setShareHasPassword(!!res.hasPassword);
        setLastPassword(sharePassword);
        pw = sharePassword;
        setSharePassword('');
      } catch {
        toast(t('Sharing failed'));
        return;
      }
    }
    if (!pw) return;
    const full = url + (url.includes('?') ? '&' : '?') + 'pw=' + encodeURIComponent(pw);
    try {
      await navigator.clipboard.writeText(full);
      toast.success(t('Public link copied'));
    } catch {
      toast(t('Sharing failed'));
    }
  };

  const stopShare = async () => {
    await api.unsharePage(pageId).catch(() => { });
    setShareUrl(null);
    forgetUrl();
    setShareOff(true);
    setShareOpen(false);
    setReadShared(false);
    setShareHasPassword(false);
    setLastPassword('');
  };

  const saveMeta = (patch: { title?: string; icon?: string; cover?: string; tags?: string[]; description?: string }) => {
    onMetaChange(pageId, patch);
    onLocalMeta(patch);
    // Accumulate across fields so a title edit followed quickly by a cover
    // change doesn't cancel the title write — a single shared timer flushes
    // the merged patch.
    Object.assign(pendingMeta.current, patch);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const merged = pendingMeta.current;
      pendingMeta.current = {};
      api.updatePage(pageId, merged).catch((e) => {
        // Temp pages and dead networks both journal into the outbox (it
        // survives reloads and remaps temp ids on flush); any other failure
        // keeps the existing in-memory retry.
        if (isTempId(pageId) || isOfflineError(e)) {
          void savePageUpdate(pageId, merged as Record<string, unknown>, { label: t('Title and properties') });
          return;
        }
        Object.assign(pendingMeta.current, merged); // keep for a later retry
        toast(t('Title/icon not saved'));
      });
    }, 500);
  };

  const setTitleAndSave = useCallback((newTitle: string) => {
    setTitle(newTitle);
    saveMeta({ title: newTitle });
  }, [pageId]);

  // Tags: client-side clean (strip '#', dedupe) is cosmetic — the server
  // re-normalizes authoritatively on save.
  const commitTags = (next: string[]) => {
    const clean: string[] = [];
    const seen = new Set<string>();
    for (let t of next) {
      t = t.trim().replace(/^#/, '').replace(/\s+/g, '-');
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(t);
    }
    setTags(clean);
    saveMeta({ tags: clean });
  };
  const addTag = (value?: string) => {
    const v = value ?? tagDraft;
    if (v.trim()) {
      commitTags([...tags, v]);
      setTagDraft('');
      setTagSuggestOpen(false);
      setTagSel(0);
    }
  };
  const removeTag = (t: string) => commitTags(tags.filter((x) => x !== t));

  // Every tag already in use is in the page metadata — no extra request needed
  // for this.
  const allTags = useMemo(() => collectTags(pagesById.values()), [pagesById]);
  const tagHits = useMemo(
    () => (tagSuggestOpen ? suggestTags(allTags, tagDraft, tags) : []),
    [tagSuggestOpen, allTags, tagDraft, tags],
  );

  const changeDescription = (v: string) => {
    setDescription(v);
    saveMeta({ description: v });
  };
  const removeDescription = () => {
    setShowDesc(false);
    changeDescription('');
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        const r = await api.importZip(file);
        toast.success(
          t('Imported {pages}', { pages: plural(r.created, '{n} page', '{n} pages') }) +
          (r.skipped ? ', ' + t('{n} skipped', { n: r.skipped }) : ''),
        );
        onPagesChanged();
      } else {
        const text = await file.text();
        const r = await api.importMarkdown(null, '', text);
        toast.success(t('Page imported'));
        onPagesChanged();
        onNavigate(r.id);
      }
    } catch (err) {
      toast((err as Error).message || t('Import failed'));
    }
  };

  const setCoverValue = (value: string) => {
    setCover(value);
    setCoverMenuOpen(false);
    saveMeta({ cover: value });
  };

  const onCoverFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = await api.upload(file);
    setCoverValue(url);
  };

  const pageWsId = page.workspaceId ?? pagesById.get(pageId)?.workspaceId;
  const foreignWorkspace =
    pageWsId && currentWs && pageWsId !== currentWs
      ? workspaces?.find((w) => w.id === pageWsId)
      : undefined;

  const breadcrumbs = useMemo(() => {
    const chain: PageMeta[] = [];
    // Database rows are excluded from the tree map, so seed the chain from the
    // loaded page itself when it isn't in pagesById — otherwise a row would show
    // no breadcrumb at all.
    let cur: PageMeta | undefined = pagesById.get(pageId) ?? page;
    let guard = 0;
    while (cur && guard++ < 30) {
      chain.unshift(cur);
      cur = cur.parentId ? pagesById.get(cur.parentId) : undefined;
    }
    return chain;
  }, [pagesById, pageId, page]);

  const inheritedAccess = useMemo(() => {
    for (let i = 0; i < breadcrumbs.length - 1; i++) {
      const a = breadcrumbs[i];
      if (a.visibility === 'private' || a.visibility === 'restricted') {
        return { title: a.title, visibility: a.visibility };
      }
    }
    return null;
  }, [breadcrumbs]);
  const isAccessRestricted = visibility !== 'workspace' || !!inheritedAccess;

  return (
    <>
      <header className="topbar">
        {onPeekClose && (
          <span className="peek-pair">
            <button className="icon-btn" title={t('Close preview')} onClick={onPeekClose}>
              <ChevronsRight size={17} />
            </button>
            {/* The expand button also carries a menu, after a moment's hover:
                the three things one wants from a preview, without a bar of
                their own in a panel this narrow. */}
            <span className="peek-open-wrap" onMouseEnter={peekMenuEnter} onMouseLeave={peekMenuLeave}>
              <button
                className={'icon-btn' + (peekPinned ? ' is-on' : '')}
                title={peekPinned ? t('Unpin') : t('Open as page ↗')}
                onClick={() => (peekPinned ? onPeekPin?.() : onPeekOpenFull?.(pageId))}
              >
                {/* Pinned, the button says so — and pressing it unpins first.
                    Only the fullscreen arrow opens the page: an icon and its
                    meaning stay one thing, and the menu beside it is where the
                    pin is managed either way. */}
                {peekPinned ? <Pin size={16} /> : <Maximize2 size={16} />}
              </button>
              {peekMenuOpen && (
                <AnchoredMenu className="menu peek-open-menu">
                  <button onClick={() => onPeekOpenFull?.(pageId)}>
                    <Maximize2 size={14} /> {t('Open full screen')}
                  </button>
                  <button onClick={() => { onOpenInNewTab?.(pageId); onPeekClose?.(); }}>
                    <SquareArrowOutUpRight size={14} /> {t('Open in a new tab')}
                  </button>
                  <button
                    className={peekPinned ? 'is-on' : ''}
                    onClick={() => {
                      onPeekPin?.();
                      setPeekMenuOpen(false);
                    }}
                    aria-pressed={!!peekPinned}
                  >
                    <Pin size={14} /> {peekPinned ? t('Unpin') : t('Pin')}
                  </button>
                </AnchoredMenu>
              )}
            </span>
          </span>
        )}
        {!onPeekClose && (
          <button className="menu-btn topbar-menu" title={t('Menu')} onClick={onMenu}>
            <Menu size={18} />
          </button>
        )}
        <nav className="breadcrumbs">
          {foreignWorkspace && (
            <span className="crumb-wrap">
              <button
                className="crumb crumb-ws-badge"
                onClick={() => onSelectWorkspace?.(foreignWorkspace.id)}
                title={foreignWorkspace.name}
              >
                {foreignWorkspace.icon && (
                  <PageIcon icon={foreignWorkspace.icon} size={13} />
                )}
                <span>{foreignWorkspace.name}</span>
              </button>
              <span className="crumb-sep">/</span>
            </span>
          )}
          {breadcrumbs.map((b, i) => (
            <span key={b.id} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">/</span>}
              <button
                className="crumb"
                onClick={(e) => openPage(e, b.id, { onNavigate, onOpenInNewTab })}
                onAuxClick={(e) => openPageAux(e, b.id, { onNavigate, onOpenInNewTab })}
              >
                {(() => {
                  const ic = b.id === pageId ? icon : b.icon;
                  const tt = (b.id === pageId ? title : b.title) || 'Untitled';
                  return (
                    <>
                      {ic && (
                        <>
                          <PageIcon icon={ic} size={13} />{' '}
                        </>
                      )}
                      {tt}
                    </>
                  );
                })()}
              </button>
            </span>
          ))}
        </nav>
        <div className="topbar-right">
          {/* Which agent says it is working here. Beside the human presence,
              because it answers the same question. */}
          <AgentPresence pageId={pageId} />
          {/* Who else is on the page right now. Presence was already being SENT
              (awareness) but shown nowhere — two people worked in the same
              document without either of them noticing. */}
          {peers.length > 0 && (
            <div className="presence" title={t('Also here: {names}').replace('{names}', peers.map((p) => p.name).join(', '))}>
              {peers.slice(0, 3).map((p, i) => (
                <span key={i} className="presence-dot" style={{ background: p.avatar ? 'transparent' : p.color }}>
                  {p.avatar ? <img src={p.avatar} alt="" /> : initials(p.name)}
                </span>
              ))}
              {peers.length > 3 && <span className="presence-dot more">+{peers.length - 3}</span>}
            </div>
          )}
          {/* One icon, marked active when the panel is open — the same shape
              the structure button has. The struck-through variant read as
              "comments are off" rather than "the panel is closed", which is a
              different and alarming thing to say about a page. */}
          {canComment && (
            <button
              className={'icon-btn topbar-wide-only' + (commentsOpen ? ' is-on' : '')}
              title={commentsOpen ? t('Hide comments') : t('Show comments')}
              onClick={() => onToggleComments(!commentsOpen)}
            >
              <MessageSquare size={17} />
              {openComments > 0 && <span className="badge-count">{openComments}</span>}
            </button>
          )}
          {/* In the side peek these two move into the ⋯ menu below — a narrow
              panel has no room for a full desktop topbar. */}
          {!onPeekClose && (
            <>
              <button
                className={'icon-btn' + (structureOpen ? ' is-on' : '')}
                title={structureOpen ? t('Hide structure') : t('Show structure')}
                onClick={onToggleStructure}
              >
                <PanelRight size={17} />
              </button>
              <button
                className={'icon-btn' + (favorite ? ' active-star' : '')}
                title={favorite ? t('Remove from favorites') : t('Add to favorites')}
                onClick={() => onToggleFavorite(pageId)}
              >
                <Star size={17} fill={favorite ? 'currentColor' : 'none'} />
              </button>
            </>
          )}
          <div className="access-wrap" ref={accessWrapRef}>
            <button
              className={'icon-btn topbar-wide-only' + (isAccessRestricted ? ' active-star' : '')}
              title={inheritedAccess ? t('Page access… (inherited)') : t('Page access…')}
              onClick={() => setSharesOpen((o) => !o)}
            >
              {isAccessRestricted ? <Lock size={17} /> : <LockOpen size={17} />}
            </button>
            {sharesOpen && (
              <PageShares
                pageId={pageId}
                workspaceId={page.workspaceId}
                myUserId={user.id}
                visibility={visibility}
                inheritedFrom={inheritedAccess}
                onClose={() => setSharesOpen(false)}
                onVisibilityChange={setVisibility}
              />
            )}
          </div>
          <div className="share-wrap" ref={shareWrapRef}>
            <button className={'icon-btn topbar-wide-only' + (isShared ? ' shared-active' : '')} title={isShared ? t('Shared') : t('Share to web (read-only link)')} onClick={openShare}>
              <Globe size={17} />
            </button>
            {shareOpen && (
              <div className="menu share-menu">
                <div className="share-hint">{isCollection ? t('Anyone with this link sees this collection (read-only).') : t('Anyone with this link can view this page (read-only).')}</div>
                {!readShared && !displayUrl ? (
                  <>
                    <button
                      className="btn-sm primary"
                      onClick={() => void mintShare(shareExpiry, sharePassword, shareAllowed, shareAllowDetail)}
                    >
                      {t('Share publicly')}
                    </button>
                    {formShared && (
                      <div className="share-hint share-hint-icon"><ClipboardList size={13} />{t('The form on this page is already shared separately.')}</div>
                    )}
                  </>
                ) : displayUrl ? (
                  <>
                    <input className="share-input" readOnly value={displayUrl} onFocus={(e) => e.currentTarget.select()} />
                    <div className="share-actions">
                      <button
                        className="btn-sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(displayUrl);
                          toast.success(t('Public link copied'));
                        }}
                      >
                        {t('Copy')}
                      </button>
                      <button className="btn-sm danger" onClick={() => void stopShare()}>
                        {t('Stop sharing')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="share-hint">{t('The link is active, but this browser does not have its URL.')}</div>
                    <button
                      className="btn-sm"
                      onClick={() => void mintShare(shareExpiry, sharePassword, shareAllowed, shareAllowDetail, true)}
                    >
                      {t('Create a new link')}
                    </button>
                  </>
                )}
                {readShared && isCollection && shareViewsList.length > 1 && (
                  <div className="share-section">
                    <div className="share-section-title">{t('Views in the link')}</div>
                    <div className="share-views">
                      {shareViewsList.map((v) => {
                        const on = shareAllowed === null || shareAllowed.includes(v.id);
                        return (
                          <label key={v.id} className="share-view-check">
                            <input type="checkbox" checked={on} onChange={() => void toggleShareView(v.id)} />
                            {v.name}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                {readShared && isCollection && (
                  <div className="share-section">
                    <label className="share-detail-check">
                      <input type="checkbox" checked={shareAllowDetail} onChange={() => void toggleShareDetail()} />
                      <span>
                        {t('Let readers open notes')}
                        <small>{t('Off = rows are visible, but do not open.')}</small>
                      </span>
                    </label>
                  </div>
                )}
                {(readShared || displayUrl) && (
                  <>
                    <label className="share-expiry">
                      Expires:
                      <select
                        className="prop-select"
                        value={shareExpiry}
                        onChange={(e) => void changeExpiry(Number(e.target.value))}
                      >
                        <option value={0}>{t('Never')}</option>
                        <option value={1}>{t('In 1 day')}</option>
                        <option value={7}>{t('In 7 days')}</option>
                        <option value={30}>{t('In 30 days')}</option>
                      </select>
                    </label>
                    <div className="share-pw-row">
                      <input
                        className="share-input"
                        type="password"
                        placeholder={shareHasPassword ? '••••••' : t('Password (optional)')}
                        value={sharePassword}
                        onChange={(e) => setSharePassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void applyPassword();
                        }}
                      />
                      <button className="btn-sm" onClick={() => void applyPassword()}>
                        {t('Apply')}
                      </button>
                    </div>
                    {displayUrl && pwForLink && (
                      <button className="btn-sm" onClick={() => void copyPwLink()}>
                        {t('Copy link with password')}
                      </button>
                    )}
                    <div className="share-hint">{t('The password applies to the current link.')}</div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="share-wrap" ref={overflowWrapRef}>
            <button
              className="icon-btn"
              title={t('More')}
              aria-label={t('More actions')}
              onClick={() => setOverflowOpen((o) => !o)}
            >
              <MoreHorizontal size={17} />
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".md,.markdown,.zip"
              style={{ display: 'none' }}
              onChange={(e) => void onImportFile(e)}
            />
            {overflowOpen && (
              <div className="menu overflow-menu">
                <>
                  <div className="menu-row" role="group" aria-label={t('Undo and redo')}>
                    <button className="menu-item" disabled={!undoCtl.canUndo} onClick={fireUndo}>
                      <Undo2 size={15} /> {t('Undo')}
                    </button>
                    <button className="menu-item" disabled={!undoCtl.canRedo} onClick={fireRedo}>
                      <Redo2 size={15} /> {t('Redo')}
                    </button>
                  </div>
                  <div className="menu-sep" />
                </>
                {onPeekClose && (
                  <>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setOverflowOpen(false);
                        onToggleStructure();
                      }}
                    >
                      <PanelRight size={15} /> {structureOpen ? t('Hide structure') : t('Show structure')}
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setOverflowOpen(false);
                        onToggleFavorite(pageId);
                      }}
                    >
                      <Star size={15} fill={favorite ? 'currentColor' : 'none'} />{' '}
                      {favorite ? t('Remove from favorites') : t('Add to favorites')}
                    </button>
                    <div className="menu-sep" />
                  </>
                )}
                {canEdit && !showDesc && !description && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setOverflowOpen(false);
                      setShowDesc(true);
                    }}
                  >
                    <AlignLeft size={15} /> {t('Add a description')}
                  </button>
                )}
                {canEdit && (showDesc || description) && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setOverflowOpen(false);
                      removeDescription();
                    }}
                  >
                    <AlignLeft size={15} /> {t('Remove description')}
                  </button>
                )}
                {canComment && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setOverflowOpen(false);
                      // Always OPENS them — an entry that toggles would be a
                      // no-op half the time somebody reaches for it.
                      onToggleComments(true);
                    }}
                  >
                    <MessageSquare size={15} /> {t('To the comments')}
                  </button>
                )}
                <button
                  className="menu-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    setHistoryOpen(true);
                  }}
                >
                  <History size={15} /> {t('Version history')}
                </button>
                {/* On a phone the topbar keeps only the star, the panel and this
                    menu — six icons side by side made the head of the page look
                    busier than its content. The three that step aside come back
                    here, so nothing becomes unreachable. */}
                <div className="menu-sep narrow-only" />
                {canComment && (
                  <button
                    className="menu-item narrow-only"
                    onClick={() => {
                      setOverflowOpen(false);
                      onToggleComments(!commentsOpen);
                    }}
                  >
                    <MessageSquare size={15} />{' '}
                    {commentsOpen ? t('Hide comments') : t('Show comments')}
                  </button>
                )}
                <button
                  className="menu-item narrow-only"
                  onClick={() => {
                    setOverflowOpen(false);
                    togglePrivate();
                  }}
                >
                  {visibility === 'private' ? <Lock size={15} /> : <LockOpen size={15} />}{' '}
                  {visibility === 'private' ? t('Make it visible to the workspace') : t('Make it private')}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    setSharesOpen(true);
                  }}
                >
                  <Lock size={15} /> {t('Page access…')}
                </button>
                <button
                  className="menu-item narrow-only"
                  onClick={() => {
                    setOverflowOpen(false);
                    openShare();
                  }}
                >
                  <Globe size={15} /> {t('Share to web (read-only link)')}
                </button>
                {onDuplicate && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setOverflowOpen(false);
                      void onDuplicate(pageId);
                    }}
                  >
                    <Copy size={15} /> {t('Duplicate')}
                  </button>
                )}
                {canEdit && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      importInput.current?.click();
                      setOverflowOpen(false);
                    }}
                  >
                    <Upload size={15} /> Import (.md / .zip)
                  </button>
                )}
                <div className="menu-sep" />
                <div className="menu-label">{t('Export')}</div>
                <button
                  className="menu-item"
                  onClick={() => {
                    api.download(`/api/export/${pageId}`);
                    setOverflowOpen(false);
                  }}
                >
                  <FileText size={15} /> Markdown (.md)
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    api.download(`/api/export/${pageId}?format=html`);
                    setOverflowOpen(false);
                  }}
                >
                  <FileCode size={15} /> {t('Web page (.html)')}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    if (page.type === 'collection') {
                      setTimeout(() => window.print(), 50);
                    } else {
                      // A clean standalone print/PDF view — works on mobile too,
                      // where window.print() is a no-op (share → save as PDF).
                      window.open(`/api/export/${pageId}?format=html&print=1`, '_blank');
                    }
                  }}
                >
                  <Printer size={15} /> {t('Print / as PDF')}
                </button>
                {canEdit && (
                  <button
                    className="menu-item danger"
                    onClick={() => {
                      setOverflowOpen(false);
                      onTrash(pageId);
                    }}
                  >
                    <Trash2 size={15} /> {t('Move to trash')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {/* Everything below the topbar scrolls as ONE page (Notion-style): the
          cover, icon, title, tags and the content leave the screen together —
          only the slim topbar stays. Crucial on mobile, where a static header
          left just a tiny scrolling window. */}
      <div className={'page-body' + (cover ? ' has-cover' : '')} ref={bodyRef} data-page-id={pageId}>
        {/* Cover, icon row and head share a wrapper so all three can hold the
          viewport's left edge on table pages, where the page scrolls sideways
          under them (see .page-head-wrap in styles.css). display: contents by
          default, so this changes no layout until that class lands. */}
        <div className="page-head-wrap">
          {cover && (
            <div className="page-cover" style={coverStyle(cover)}>
              <div className="page-cover-actions">
                <input
                  ref={coverInput}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={onCoverFile}
                />
                <button className="cover-btn" onClick={() => setCoverMenuOpen((o) => !o)}>
                  {t('Change cover')}
                </button>
                <button className="cover-btn" onClick={() => setCoverValue('')}>
                  {t('Remove')}
                </button>
                {coverMenuOpen && (
                  <CoverMenu
                    onGradient={setCoverValue}
                    onUpload={() => coverInput.current?.click()}
                    onClose={() => setCoverMenuOpen(false)}
                  />
                )}
              </div>
            </div>
          )}
          {/* The icon row lives OUTSIDE .page-head so it can dock (sticky) on the
          collapsed cover strip while scrolling — the big emoji stays fully
          visible instead of sliding half-hidden under the banner. */}
          <div className={'page-icon-row' + (page.type === 'collection' ? ' page-icon-row--db' : '')}>
            {icon && (
              <button className="page-icon icon-trigger" onClick={() => setIconPickerOpen((o) => !o)}>
                <PageIcon icon={icon} size={54} />
              </button>
            )}
            {iconPickerOpen && (
              <IconPicker
                pageId={pageId}
                onPick={(e) => {
                  setIcon(e);
                  setIconPickerOpen(false);
                  saveMeta({ icon: e });
                }}
                onRemove={() => {
                  setIcon('');
                  setIconPickerOpen(false);
                  saveMeta({ icon: '' });
                }}
                onClose={() => setIconPickerOpen(false)}
              />
            )}
            {historyOpen && (
              <HistoryModal
                pageId={pageId}
                onClose={() => setHistoryOpen(false)}
                onRestored={onPagesChanged}
              />
            )}
          </div>
          <div className={'page-head' + (cover ? ' with-cover' : '') + (page.type === 'collection' ? ' page-head--db' : '')}>
            <textarea
              ref={titleRef}
              {...navItem('title', { keepTabOrder: true })}
              className="page-title"
              value={title}
              placeholder={t('Untitled')}
              rows={1}
              onChange={(e) => {
                setTitle(e.target.value);
                saveMeta({ title: e.target.value });
              }}
              onKeyDown={(e) => {
                // A title is a single line of text: Enter never inserts a newline
                // (it jumps into the body instead of breaking the title).
                if (e.key === 'Enter') {
                  e.preventDefault();
                  focusBodyStart();
                } else if (e.key === 'ArrowRight' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                  const ta = titleRef.current;
                  if (ta && ta.selectionStart === ta.selectionEnd && ta.selectionStart === ta.value.length) {
                    e.preventDefault();
                    focusBodyStart();
                  }
                }
              }}
            />
            {/* A permanently visible add row BELOW the title (rather than buttons
            hidden behind hover — unreachable on touch devices as soon as there
            was a cover). Shows only what is still missing: emoji, cover,
            description. */}
            {canEdit && (!icon || !cover || (!showDesc && !description)) && (
              <div className="head-adders">
                <input
                  ref={coverInput}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={onCoverFile}
                />
                {!icon && (
                  <button className="add-btn" onClick={() => setIconPickerOpen((o) => !o)}>
                    <Smile size={14} /> {t('Emoji')}
                  </button>
                )}
                {!cover && (
                  <button className="add-btn cover-trigger" onClick={() => setCoverMenuOpen((o) => !o)}>
                    <ImageIcon size={14} /> {t('Cover')}
                  </button>
                )}
                {!showDesc && !description && (
                  <button className="add-btn" onClick={() => setShowDesc(true)}>
                    <AlignLeft size={14} /> {t('Description')}
                  </button>
                )}
                {/* Cover menu only here while NO cover exists — with one, the
                "Change cover" button top right renders it (W32c: two instances
                on the same state eat each other's clicks). */}
                {!cover && coverMenuOpen && (
                  <CoverMenu
                    onGradient={setCoverValue}
                    onUpload={() => coverInput.current?.click()}
                    onClose={() => setCoverMenuOpen(false)}
                  />
                )}
              </div>
            )}
            {(showDesc || description) && (
              <div className="page-description">
                {canEdit ? (
                  <textarea
                    value={description}
                    placeholder={t('Add a description…')}
                    rows={1}
                    autoFocus={showDesc && !description}
                    onChange={(e) => {
                      changeDescription(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    onBlur={(e) => {
                      if (!e.target.value.trim()) setShowDesc(false);
                    }}
                    ref={(el) => {
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                      }
                    }}
                  />
                ) : (
                  <div>{description}</div>
                )}
              </div>
            )}
            {(canEdit || tags.length > 0) && (
              <div className="page-tags">
                {tags.map((t) => (
                  <TagChip
                    key={t}
                    tag={t}
                    colors={tagColors}
                    canEdit={canEdit}
                    onRemove={() => removeTag(t)}
                    onSetColor={(c) => onSetTagColor(t, c)}
                  />
                ))}
                {canEdit && (
                  <span className="tag-input-wrap">
                    <input
                      className="page-tag-input"
                      value={tagDraft}
                      placeholder={tags.length ? t('+ Tag') : t('+ Add a tag')}
                      onChange={(e) => {
                        setTagDraft(e.target.value);
                        setTagSuggestOpen(true);
                        setTagSel(0);
                      }}
                      onFocus={() => setTagSuggestOpen(true)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          if (!tagHits.length) return;
                          e.preventDefault();
                          const d = e.key === 'ArrowDown' ? 1 : -1;
                          setTagSel((i) => (i + d + tagHits.length) % tagHits.length);
                        } else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                          // A highlighted suggestion beats the raw text — otherwise
                          // Enter creates a duplicate after all.
                          const pick = tagSuggestOpen ? tagHits[tagSel] : undefined;
                          if (!pick && !tagDraft.trim()) return; // Tab darf normal weiterspringen
                          e.preventDefault();
                          addTag(pick?.tag);
                        } else if (e.key === 'Escape') {
                          setTagSuggestOpen(false);
                        } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
                          removeTag(tags[tags.length - 1]);
                        }
                      }}
                      onBlur={() => {
                        // Clicks on a suggestion only fire after the blur.
                        setTimeout(() => {
                          setTagSuggestOpen(false);
                          addTag();
                        }, 120);
                      }}
                    />
                    {tagSuggestOpen && tagHits.length > 0 && (
                      <div className="tag-suggest">
                        {tagHits.map((s, i) => (
                          <button
                            key={s.tag}
                            type="button"
                            className={'tag-suggest-item' + (i === tagSel ? ' on' : '')}
                            onMouseDown={(e) => e.preventDefault()} // Blur zuvorkommen
                            onClick={() => addTag(s.tag)}
                          >
                            <span className={'tag-chip ' + tagColorClass(s.tag, tagColors)}>#{s.tag}</span>
                            <span className="tag-suggest-count">{s.count}</span>
                            {s.similar && <span className="tag-suggest-hint">{t('similar')}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
              </div>
            )}
            {page.parentId && pagesById.get(page.parentId)?.type === 'collection' && (
              <RowProperties
                pageId={pageId}
                parentId={page.parentId}
                initialProps={page.props}
                canEdit={canEdit}
                onOpen={onOpenInNewTab ?? onNavigate}
                openers={{ onNavigate, onOpenInNewTab }}
                onPagesChanged={onPagesChanged}
              />
            )}
          </div>
          <PageTitleContext.Provider value={{ title, setTitleAndSave, titleRef, registerFocusBodyStart }}>
            {children}
          </PageTitleContext.Provider>
        </div>
        {/* The raw trail stays at the foot of the document. Comments moved to a
          panel beside it (CommentsPanel) because people WORK in them; the trail
          is read, rarely, when somebody doubts the written-up version — and
          under the account it supports is exactly where it belongs.

          Only for documents and rows: a database page carries its table down
          here, and anything below that is lost. */}
        {page.type !== 'collection' && (
          <div className="trail-wrap">
            <NoteTrail pageId={pageId} canWrite={canEdit} />
          </div>
        )}
      </div>
    </>
  );
}

function CoverMenu({
  onGradient,
  onUpload,
  onClose,
}: {
  onGradient: (value: string) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      // Ignore this menu's own triggers (they toggle it); a click on the icon
      // trigger correctly falls through and closes the cover menu.
      if (t.closest?.('.cover-trigger, .cover-btn')) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div className="cover-menu" ref={ref}>
      <button className="cover-upload" onClick={onUpload}>
        <Upload size={15} /> {t('Upload image')}
      </button>
      <div className="cover-grid">
        {COVER_GRADIENTS.map((g) => (
          <button
            key={g}
            className="cover-swatch"
            style={{ background: g.slice('gradient:'.length) }}
            onClick={() => onGradient(g)}
          />
        ))}
      </div>
    </div>
  );
}

// ---- realtime block editor ----

interface CollabProps {
  page: Page;
  user: User;
  theme: 'light' | 'dark';
  canEdit: boolean;
  pagesById: Map<string, PageMeta>;
  tagColors: Record<string, string>;
  onNavigate: (id: string | null) => void;
  onOpenInNewTab: (id: string) => void;
  onCreatePage: (parentId: string | null, type?: 'doc' | 'collection') => void;
  onPagesChanged: () => void;
  onReset: () => void;
  /** The panel lists linked references too; the strip under the body stands in
   *  while it is closed, so the information is never in two places at once and
   *  never in none. */
  structureOpen: boolean;
  /** Keyboard-navigation region of the owning editor ('content', or 'peek' in
   *  the side panel). Flows through ...rest to BlockContent. */
  regionId: string;
}

function CollabEditor({ page, user, theme, canEdit, onReset, ...rest }: CollabProps) {
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<SaltProvider | null>(null);
  const seedRef = useRef<unknown[] | null>(null);

  // The provider lives in the effect, not in the render. The earlier useMemo
  // approach broke twice over under StrictMode: the double render leaked one
  // ghost connection along with its presence (useRef is fresh on the second
  // pass, so the guard never saw anything), and the setup→cleanup→setup cycle
  // destroyed the committed provider for good — dev hung on a dead Y.Doc.
  // Here, setup→cleanup→setup simply produces a second provider.
  useEffect(() => {
    let cancelled = false;
    let p: SaltProvider | null = null;
    let saveTimer = 0;
    let onVisibility: (() => void) | null = null;
    // Restore the offline snapshot first so edits typed before a reload are
    // not lost; the provider merges it with the server replay on connect.
    void getYDoc(page.id).then((initialUpdate) => {
      if (cancelled) return;
      const scheduleSave = () => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          try {
            if (p) {
              const cur = Y.encodeStateAsUpdate(p.doc);
              if (cur.length > 0) void putYDoc(page.id, cur);
            }
          } catch {
            /* snapshot is best-effort */
          }
        }, 1000);
      };
      p = new SaltProvider(
        page.id,
        page.docGen ?? null,
        (isNew) => {
          // Seed a brand-new CRDT doc from the page's stored content once.
          if (isNew && Array.isArray(page.content) && page.content.length > 0) {
            seedRef.current = page.content;
          }
          setReady(true);
        },
        onReset,
        { initialUpdate, onLocalUpdate: () => scheduleSave() },
      );
      // Presence means "is looking at this page right now": a tab in a hidden
      // window must not show up as a peer for hours. Doc sync stays connected;
      // only the awareness state is withdrawn. IMPORTANT: setLocalState, not
      // setLocalStateField — after setLocalState(null) the latter is a silent
      // no-op (y-protocols checks state !== null), and presence would never come
      // back after switching tabs.
      const applyPresence = () => {
        if (!p) return;
        if (document.visibilityState === 'hidden') {
          p.awareness.setLocalState(null);
        } else {
          p.awareness.setLocalState({
            user: { name: user.name, color: user.color, avatar: user.avatar },
          });
        }
      };
      onVisibility = applyPresence;
      applyPresence();
      // Awareness has long known about the others — you just never saw them.
      // Here they are written into the presence store the header reads.
      const pushPeers = () => {
        if (!p) return;
        const mine = p.awareness.clientID;
        const out: { name: string; color: string; avatar?: string }[] = [];
        p.awareness.getStates().forEach((state: Record<string, unknown>, id: number) => {
          if (id === mine) return;
          const u = state.user as { name?: string; color?: string; avatar?: string } | undefined;
          if (u?.name) out.push({ name: u.name, color: u.color || '#888', avatar: u.avatar });
        });
        setPeers(page.id, out);
      };
      p.awareness.on('change', pushPeers);
      pushPeers();
      document.addEventListener('visibilitychange', applyPresence);
      setProvider(p);
      // A restored snapshot renders now, without waiting for a sync that may
      // never come while offline: the body below reads the local doc, and the
      // provider merges it with the server replay on connect. With no snapshot
      // and no connection there is likewise nothing to wait for.
      if ((initialUpdate && initialUpdate.length > 0) || !navigator.onLine) setReady(true);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(saveTimer);
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
      clearPeers(page.id);
      setReady(false); // the next provider (StrictMode) gates itself again
      // Flush the latest state so a tab closed right now keeps its edits.
      // Skipped after a server-side reset: the local doc is stale, and
      // persisting it would resurrect exactly what was replaced.
      try {
        if (p && !p.reset) {
          const cur = Y.encodeStateAsUpdate(p.doc);
          if (cur.length > 0) void putYDoc(page.id, cur);
        }
      } catch {
        /* best-effort */
      }
      try {
        p?.destroy();
      } catch {
        /* best-effort */
      }
      setProvider(null);
    };
    // page.id is constant over the lifetime (key={currentId} remounts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  if (!provider || !ready) return <div className="editor-loading" />;
  return (
    <BlockContent
      provider={provider}
      pageId={page.id}
      seed={seedRef.current}
      hadContent={Array.isArray(page.content) && page.content.length > 0}
      user={user}
      theme={theme}
      canEdit={canEdit}
      {...rest}
    />
  );
}

// A BlockNote document counts as "empty" when it's a single empty paragraph.
function isEffectivelyEmpty(doc: unknown[]): boolean {
  if (!Array.isArray(doc) || doc.length === 0) return true;
  if (doc.length > 1) return false;
  const b = doc[0] as { type?: string; content?: unknown[] };
  return b?.type === 'paragraph' && (!b.content || b.content.length === 0);
}

function inlineContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (Array.isArray(item?.content)) return inlineContentToText(item.content);
      return '';
    })
    .join('');
}

function BlockContent({
  provider,
  pageId,
  seed,
  hadContent,
  user,
  theme,
  canEdit,
  pagesById,
  tagColors,
  onNavigate,
  onOpenInNewTab,
  onCreatePage,
  onPagesChanged,
  structureOpen,
  regionId,
}: {
  provider: SaltProvider;
  pageId: string;
  seed: unknown[] | null;
  hadContent: boolean;
  structureOpen: boolean;
  regionId: string;
  user: User;
  theme: 'light' | 'dark';
  canEdit: boolean;
  pagesById: Map<string, PageMeta>;
  tagColors: Record<string, string>;
  onNavigate: (id: string | null) => void;
  onOpenInNewTab: (id: string) => void;
  onCreatePage: (parentId: string | null, type?: 'doc' | 'collection') => void;
  onPagesChanged: () => void;
}) {
  const editor = useCreateBlockNote({
    schema: saltSchema,
    collaboration: {
      provider,
      fragment: provider.doc.getXmlFragment('blocknote'),
      user: { name: user.name, color: user.color },
    },
    // The page travels with the upload: it is what makes a dropped PDF
    // searchable (indexFileText) and what puts the file in the workspace's
    // file list. Without it a PDF added in the browser stayed invisible to
    // both, while the same PDF added by an agent did not — the MCP path has
    // always passed a page id.
    uploadFile: (file: File) => api.upload(file, pageId),
    // Column layout: edge-drop cursor + its dictionary entries.
    dictionary: coreEn,
    pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
      const types = event.clipboardData?.types || [];
      if (types.includes('blocknote/html') || types.includes('vscode-editor-data')) {
        return defaultPasteHandler();
      }
      if (event.clipboardData?.files && event.clipboardData.files.length > 0) {
        return defaultPasteHandler();
      }

      const plain = event.clipboardData?.getData('text/plain') ?? '';
      const html = event.clipboardData?.getData('text/html') ?? '';

      // Complex structural elements (tables, code blocks, quotes) belong to HTML parser
      const hasComplexHtml = /<(?:table|thead|tbody|tr|td|th|pre|code|blockquote)\b/i.test(html);
      if (hasComplexHtml) {
        return defaultPasteHandler();
      }

      const lines = plain.split(/\r?\n/).map((l) => l.trimEnd());
      const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

      if (nonEmptyLines.length > 1) {
        let currentBlock: any;
        try {
          currentBlock = ed.getTextCursorPosition()?.block;
        } catch {
          // cursor outside or unknown
        }

        const currentType = currentBlock?.type;
        let blocksToInsert: any[] = [];

        if (currentType === 'checkListItem') {
          const md = nonEmptyLines.map((l) => `- [ ] ${l.replace(/^[-*•]\s*(\[[ xX]\]\s*)?/, '')}`).join('\n');
          blocksToInsert = ed.tryParseMarkdownToBlocks(md);
        } else if (currentType === 'bulletListItem') {
          const md = nonEmptyLines.map((l) => `- ${l.replace(/^[-*•]\s*/, '')}`).join('\n');
          blocksToInsert = ed.tryParseMarkdownToBlocks(md);
        } else if (currentType === 'numberedListItem') {
          const md = nonEmptyLines.map((l, i) => `${i + 1}. ${l.replace(/^\d+[.)]\s*/, '')}`).join('\n');
          blocksToInsert = ed.tryParseMarkdownToBlocks(md);
        } else {
          const md = plain.includes('\n\n') ? plain : nonEmptyLines.join('\n\n');
          blocksToInsert = ed.tryParseMarkdownToBlocks(md);
          if (blocksToInsert.length <= 1) {
            blocksToInsert = nonEmptyLines.map((l) => ({
              type: 'paragraph',
              content: [l],
            }));
          }
        }

        if (blocksToInsert.length > 0) {
          if (currentBlock) {
            const isCurrentEmpty =
              !currentBlock.content ||
              currentBlock.content.length === 0 ||
              (currentBlock.content.length === 1 &&
                currentBlock.content[0].type === 'text' &&
                !currentBlock.content[0].text);

            if (isCurrentEmpty) {
              const res = ed.replaceBlocks([currentBlock.id], blocksToInsert);
              const last = res.insertedBlocks[res.insertedBlocks.length - 1];
              if (last) ed.setTextCursorPosition(last, 'end');
              return true;
            } else {
              const inserted = ed.insertBlocks(blocksToInsert, currentBlock.id, 'after');
              const last = inserted[inserted.length - 1];
              if (last) ed.setTextCursorPosition(last, 'end');
              return true;
            }
          } else {
            const doc = ed.document;
            const ref = doc[doc.length - 1];
            if (ref) {
              const inserted = ed.insertBlocks(blocksToInsert, ref.id, 'after');
              const last = inserted[inserted.length - 1];
              if (last) ed.setTextCursorPosition(last, 'end');
              return true;
            }
          }
        }
      }

      // If HTML from mobile has no block tags (<p>), tryParseHTMLToBlocks returns 0 blocks.
      // Fall back to plain text so the paste is never silently dropped.
      if (html) {
        const parsedHtmlBlocks = ed.tryParseHTMLToBlocks(html);
        if (parsedHtmlBlocks.length === 0 && plain) {
          ed.pasteText(plain);
          return true;
        }
      }

      return defaultPasteHandler();
    },
  });

  // Doc undo for the ⋯ menu: BlockNote's own history, announced so the
  // topbar (outside this tree) can offer the buttons beside the collection
  // ones. Local edits only — remote ones are somebody else's to take back.
  // The states self-correct: a no-op call (empty stack) switches its own
  // side back off, and a fresh edit burns the redo tail, like everywhere.
  const [docUndo, setDocUndo] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const off = editor.onChange(() => setDocUndo({ canUndo: true, canRedo: false }), false);
    return off;
  }, [editor]);
  useEffect(() => {
    writeDocUndoState(pageId, regionId, docUndo);
    window.dispatchEvent(
      new CustomEvent('salt:doc-undo-state', {
        detail: { pageId, region: regionId, ...docUndo },
      }),
    );
  }, [pageId, regionId, docUndo]);
  useEffect(() => {
    const ordered = (e: Event, redo: boolean) => {
      const d = (e as CustomEvent<{ pageId?: string; region?: string }>).detail;
      if (!d || d.pageId !== pageId || d.region !== regionId) return;
      const ok = redo ? editor.redo() : editor.undo();
      setDocUndo((s) => (redo ? { ...s, canRedo: ok } : { canUndo: ok, canRedo: true }));
    };
    const onUndo = (e: Event) => ordered(e, false);
    const onRedo = (e: Event) => ordered(e, true);
    window.addEventListener('salt:doc-undo', onUndo);
    window.addEventListener('salt:doc-redo', onRedo);
    return () => {
      window.removeEventListener('salt:doc-undo', onUndo);
      window.removeEventListener('salt:doc-redo', onRedo);
    };
  }, [editor, pageId, regionId]);

  // Ctrl+Enter, kept literal (not `mod`) on every platform — ⌘↩ already means
  // something to plenty of hands from other editors, and borrowing it here
  // would fight that. Ticks whatever checklist line the cursor is CURRENTLY
  // inside: BlockNote hands back the whole block, not the run of text under
  // the caret, so this works from anywhere on the line. With a range selected
  // across several lines, getSelection() answers instead of the cursor — every
  // checklist line it touches flips on its own, so a selection with two boxes
  // ticked and three not does not collapse into one state, it just keeps
  // flipping each. `when` limits it to the document actually holding focus —
  // the region has exactly one item ('body') below the title — and `run`
  // returns false when nothing in reach is a checklist line, so the chord
  // falls through untouched everywhere else.
  useShortcut({
    id: 'checkbox.toggle',
    keys: ['mod+enter', 'ctrl+enter'],
    scope: 'editor',
    whileTyping: true,
    when: () => canEdit && focusedKey(regionId) === 'body',
    label: () => t('Tick/untick the checkbox'),
    group: () => t('Page'),
    run: () => {
      const selection = editor.getSelection();
      const blocks = selection ? selection.blocks : [editor.getTextCursorPosition().block];
      let touched = false;
      for (const b of blocks) {
        if (b.type !== 'checkListItem') continue;
        editor.updateBlock(b, { props: { checked: !b.props.checked } } as never);
        touched = true;
      }
      if (!touched) return false;
    },
  });

  // Alt+↑/↓, not Mod+Shift+↑/↓ (BlockNote's own default for the same move —
  // still there underneath, just not what anyone's hand reaches for first).
  // moveBlocksUp/Down act on the selection when there is one and the cursor's
  // own block otherwise, so this needs no lookup of its own.
  useShortcut({
    id: 'block.moveUp',
    keys: ['alt+arrowup'],
    scope: 'editor',
    whileTyping: true,
    when: () => canEdit && focusedKey(regionId) === 'body',
    label: () => t('Move block up'),
    group: () => t('Page'),
    run: () => editor.moveBlocksUp(),
  });
  useShortcut({
    id: 'block.moveDown',
    keys: ['alt+arrowdown'],
    scope: 'editor',
    whileTyping: true,
    when: () => canEdit && focusedKey(regionId) === 'body',
    label: () => t('Move block down'),
    group: () => t('Page'),
    run: () => editor.moveBlocksDown(),
  });

  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);

  // The dictionary key behind an English default title ("Heading 1" behind
  // "heading"), so extra aliases can be looked up in every language. The React
  // items carry no key — only the title — and the dictionary is keyed the
  // other way round.
  const slashKeyOf = (() => {
    const byTitle = new Map<string, string>();
    for (const [key, entry] of Object.entries(
      coreEn.slash_menu as Record<string, { title?: string }>,
    )) {
      if (entry?.title) byTitle.set(entry.title, key);
    }
    return (title: string) => byTitle.get(title);
  })();
  // Aliases of one slash-menu entry in every shipped dictionary. The custom
  // items below carry their own trilingual aliases inline.
  //
  // Two entries have no Russian alias in any dictionary — neither the title
  // (the active dictionary is English) nor the aliases would answer a Russian
  // query — so they get one here rather than waiting on the library.
  const RU_GAP_FILL: Record<string, string[]> = {
    quote: ['цитата'],
    divider: ['разделитель', 'линия', 'черта'],
    paragraph: ['абзац', 'текст'],
  };
  function slashAliases(title: string): string[] {
    const key = slashKeyOf(title);
    if (!key) return [];
    const out: string[] = [...(RU_GAP_FILL[key] ?? [])];
    for (const dict of [coreEn, coreDe, coreRu]) {
      const entry = (dict.slash_menu as Record<string, { aliases?: string[] } | undefined>)[key];
      if (entry?.aliases) out.push(...entry.aliases);
    }
    return out;
  }

  // Slash menu: default items + column layout + our custom blocks.
  const getSlashItems = async (query: string) => {
    const custom = [
      {
        title: t('Diagram'),
        subtext: t('A flow chart written as text'),
        aliases: ['diagram', 'diagramm', 'mermaid', 'flow', 'flussdiagramm', 'graph', 'диаграмма', 'схема', 'граф', 'блок-схема'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
        group: 'Advanced',
        icon: <Workflow size={18} />,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, {
            type: 'mermaid',
            props: { code: 'graph TD\n  A[Start] --> B[Done]' },
          } as never),
      },
      {
        title: t('Columns'),
        subtext: t('Two blocks side by side'),
        aliases: ['columns', 'column', 'spalten', 'nebeneinander', 'колонки', 'столбцы', 'рядом', 'колонка'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
        group: 'Basic blocks',
        icon: <Columns2 size={18} />,
        // Inserted WITH its two children, because an empty columns block is a
        // control strip and nothing else — there would be no column to type in
        // and no obvious way to make one.
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, {
            type: 'columns',
            props: { count: 2 },
            children: [{ type: 'paragraph' }, { type: 'paragraph' }],
          } as never),
      },
      {
        title: t('Callout'),
        subtext: t('A highlighted note with an emoji'),
        aliases: ['callout', 'hinweis', 'info', 'warnung', 'выноска', 'заметка', 'подсказка', 'важно'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)lingual so a German user can type it
        group: 'Basic blocks',
        icon: <span>💡</span>,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, { type: 'callout' } as never),
      },
      {
        title: t('Bookmark / Embed'),
        subtext: t('A link card, or a YouTube/Vimeo player'),
        aliases: ['bookmark', 'embed', 'link', 'video', 'youtube', 'закладка', 'встроить', 'ссылка', 'видео'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)lingual so a German user can type it
        group: 'Media',
        icon: <span>🔖</span>,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, { type: 'bookmark' } as never),
      },
      {
        title: t('Embed a collection'),
        subtext: t('Show an existing collection inside the document'),
        aliases: ['datenbank', 'database', 'db', 'tabelle', 'board', 'kanban', 'база', 'коллекция', 'таблица', 'доска', 'встроить коллекцию'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)lingual so a German user can type it
        group: 'Basic blocks',
        icon: <span>▦</span>,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, { type: 'database' } as never),
      },
      {
        title: t('Table of contents'),
        subtext: t('Auto-generated list of every heading'),
        aliases: ['toc', 'inhalt', 'inhaltsverzeichnis', 'outline', 'оглавление', 'содержание'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)lingual so a German user can type it
        group: 'Basic blocks',
        icon: <span>📑</span>,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'toc' } as never),
      },
      {
        title: t('Sub-pages'),
        subtext: t('List of pages below this one'),
        aliases: ['subpages', 'unterseiten', 'children', 'sub-pages', 'подстраницы', 'дочерние', 'страницы', 'вложенные'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)lingual so a German user can type it
        group: 'Basic blocks',
        icon: <span>📄</span>,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'subpages' } as never),
      },
    ];
    // Every item searchable in every language, always: the menu matches the
    // query against the title and the aliases, so each default item carries the
    // union of its English, German and Russian aliases on top of whatever the
    // active dictionary gave it. Display stays as the dictionary says; what the
    // fingers may type does not depend on it.
    const defaults = getDefaultReactSlashMenuItems(editor).map((it) => ({
      ...it,
      aliases: [...(it.aliases ?? []), ...slashAliases(it.title)],
    }));
    return filterSuggestionItems([...defaults, ...custom], query);
  };

  // Page-link menu (shared by the "@" mention trigger and the "[[" wiki-link
  // trigger): existing pages plus a "create new page" action.
  // Guards out-of-order server answers: one request per keystroke, and a slow
  // one resolving after a newer round falls back to the local items rather
  // than clobbering the menu with a stale list.
  const linkSeq = useRef(0);
  const buildLinkItems = async (query: string) => {
    const q = query.toLowerCase();
    const matches = [...pagesById.values()]
      .filter((p) => !p.trashed && p.id !== provider.pageId)
      .filter((p) => (p.title || 'Untitled').toLowerCase().includes(q))
      .slice(0, 12);
    const seen = new Set(matches.map((p) => p.id));
    seen.add(provider.pageId);
    const items = matches.map((p) => ({
      title: p.title || 'Untitled',
      subtext: p.type === 'collection' ? 'Database' : 'Page',
      onItemClick: () =>
        editor.insertInlineContent([
          { type: 'pageLink', props: { pageId: p.id, label: p.title || 'Untitled' } },
          ' ',
        ]),
    }));
    // Collection rows never enter the client page list (/api/pages leaves out
    // children of collections), so the local filter above cannot see them —
    // but they open, peek and backlink like any page. Complete them from the
    // server search: rows carry their collection in parentTitle, while plain
    // documents are already covered by the local matches above.
    if (query.trim()) {
      const seq = ++linkSeq.current;
      try {
        const hits = await api.search(query.trim());
        if (seq === linkSeq.current) {
          let added = 0;
          for (const h of hits) {
            if (added >= 5 || !h.parentId || seen.has(h.id)) continue;
            seen.add(h.id);
            added++;
            const label = h.title || t('Untitled');
            const collection = h.parentTitle || t('Untitled');
            const pageId = h.id;
            items.push({
              title: label,
              subtext: t('in {collection}', { collection }),
              onItemClick: () =>
                editor.insertInlineContent([
                  { type: 'pageLink', props: { pageId, label } },
                  ' ',
                ]),
            });
          }
        }
      } catch {
        /* offline: local matches only */
      }
    }
    if (query.trim()) {
      items.push({
        title: `Create "${query.trim()}"`,
        subtext: 'New page',
        onItemClick: async () => {
          try {
            const created = await api.createPage(null, query.trim());
            onPagesChanged();
            editor.insertInlineContent([
              { type: 'pageLink', props: { pageId: created.id, label: created.title || query.trim() } },
              ' ',
            ]);
          } catch (e) {
            // Offline: journal the page but insert no link — a link to a temp
            // id would dangle after the flush remaps it, and there is no
            // in-doc fixup pass. The page itself appears in the tree on sync.
            if (isOfflineError(e)) {
              const tempId = newTempId();
              const now = new Date().toISOString();
              await putCachedPage({
                id: tempId,
                parentId: null,
                title: query.trim(),
                icon: '',
                cover: '',
                position: Date.now(),
                updatedAt: now,
                trashed: false,
                type: 'doc',
                props: {},
                workspaceId: '',
                ownerId: '',
                visibility: 'workspace',
                isTemplate: false,
                tags: [],
                description: '',
                snippet: '',
                thumb: '',
                content: [],
                createdAt: now,
              });
              await enqueue({
                kind: 'create-page',
                pageId: tempId,
                parentId: null,
                payload: { title: query.trim(), type: 'doc', props: {} },
                label: query.trim(),
              });
              onPagesChanged();
              toast.warning(t('Will sync when the connection is back'));
              return;
            }
            console.error('salt.md: failed to create page from mention', e);
          }
        },
      });
    }
    return items;
  };

  const getMentionItems = (query: string) => buildLinkItems(query);
  // Wiki-links: the trigger is "[", and BlockNote has no real concept of a
  // two-character one — passing it "[[" never fires on ordinary typing,
  // since its match compares the WHOLE trigger string against (n trailing
  // characters already in the doc) + (the character just typed), which is
  // always one character too long to equal an n-character trigger.
  //
  // So "[[" is two separate triggers of the same one-character kind. The
  // first opens a menu with an empty query; typing the second "[" re-matches
  // the same trigger, and BlockNote's reaction to a trigger firing while one
  // is already open is to close the old menu and start a completely fresh
  // one anchored right after this new "[" — it does not extend the query
  // with the character, so the menu's query is only ever what comes after
  // the LAST "[" typed. Selecting an item then deletes just that: the second
  // "[" and the query text, leaving the first "[" sitting untouched right
  // before wherever the item's own onItemClick inserts things.
  //
  // Deleting it here — once, before the item does its own thing — is
  // cheaper than fighting the plugin for a query that spans both brackets.
  const getWikiItems = async (raw: string) => {
    const items = await buildLinkItems(raw);
    return items.map((item) => ({
      ...item,
      onItemClick: () => {
        editor.transact((tr) => {
          const pos = tr.selection.from;
          if (pos > 0 && tr.doc.textBetween(pos - 1, pos) === '[') tr.delete(pos - 1, pos);
        });
        item.onItemClick();
      },
    }));
  };

  // Seed initial content into an empty shared doc exactly once. If seeding
  // throws (e.g. a block shape BlockNote rejects), we must NOT enter the
  // materialize path, or the debounced write would persist an empty document
  // over the real stored content.
  const seededRef = useRef(false);
  const seedFailed = useRef(false);
  useEffect(() => {
    if (seededRef.current || !seed || seed.length === 0) return;
    seededRef.current = true;
    const frag = provider.doc.getXmlFragment('blocknote');
    if (frag.length === 0) {
      try {
        editor.replaceBlocks(editor.document, seed as never);
      } catch (e) {
        seedFailed.current = true;
        console.error('salt.md: failed to seed page content', e);
      }
    }
  }, [editor, provider, seed]);

  // Persist a materialized copy to pages.content so search, export, backlinks
  // and the Markdown/MCP API see current text. Debounced; skips the CRDT reset.
  const matTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      if (seedFailed.current || !dirty.current) return;
      // The server replaced the document under us (reset by either
      // signal): this copy is stale. Drop it instead of writing it
      // over the rewrite — the pre-reset state survives as a revision.
      // (A replaced copy WITH a generation goes out named, and the
      // server refuses it itself; one with no generation behind it
      // is dropped here, since a server that sends no generation
      // would write it.)
      if (provider.reset || (provider.replacedDoc && provider.gen === null)) {
        dirty.current = false;
        return;
      }
      const doc = editor.document;
      // Guard against clobbering stored content with an accidentally-empty doc.
      if (hadContent && isEffectivelyEmpty(doc)) return;
      dirty.current = false;
      // Named so the server can refuse a copy of a replaced document even when
      // the 4001 never reached this tab (server/docgen.go).
      const opts = { materialize: true, gen: provider.gen, replaced: provider.replacedDoc };
      if (keepalive) {
        // Unmount (e.g. following a link chip): a normal fetch would be
        // cancelled, so use keepalive to guarantee the write — otherwise the
        // just-inserted @-mention's backlink would never be recorded.
        void fetch(`/api/pages/${provider.pageId}${materializeQuery(opts)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: doc }),
          keepalive: true,
        });
      } else {
        api.updatePage(provider.pageId, { content: doc }, opts).catch((e: unknown) => {
          // Dead network or a not-yet-synced temp page: journal the snapshot
          // (the outbox replays it after the create). A 404 here means the
          // page was deleted or replaced under us — say so plainly (#4).
          if (isTempId(provider.pageId) || isOfflineError(e)) {
            dirty.current = false;
            void savePageUpdate(
              provider.pageId,
              { content: doc } as Record<string, unknown>,
              { materialize: true, label: t('Page content') },
            );
            return;
          }
          if (e instanceof ApiError && e.code === 'doc_replaced') {
            // Replaced while our socket was down: reload onto the new document.
            provider.replaced();
            return;
          }
          if (e instanceof ApiError && e.status === 404) {
            toast.warning(t('This page was deleted on the server. Open the trash to get it back.'));
            return;
          }
          dirty.current = true; // retry on next change / unmount flush
          toast(t('Page content not saved'));
        });
      }
    };
    const persist = () => {
      if (provider.reset) return;
      dirty.current = true;
      window.clearTimeout(matTimer.current);
      matTimer.current = window.setTimeout(() => flush(false), 1500);
    };
    const unsub = editor.onChange?.(persist);
    return () => {
      window.clearTimeout(matTimer.current);
      flush(true); // flush any pending edit before this editor unmounts
      if (typeof unsub === 'function') unsub();
    };
  }, [editor, provider, hadContent]);

  // A file block otherwise goes straight to the download folder — you cannot
  // glance at an attachment without leaving Salt and coming back. Catching the
  // click in the CAPTURE phase is what makes this work without touching
  // BlockNote's own file block: React registers capture listeners on its root
  // container, so this runs before the event ever reaches the block's own
  // handler, and stopPropagation keeps the download from firing underneath the
  // viewer. Anything we do not preview is simply left alone.
  const onFileClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.bn-file-name-with-icon')) return;
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    if (!id) return;
    const props = editor.getBlock(id)?.props as { url?: string; name?: string } | undefined;
    const url = props?.url;
    if (!url || !isPreviewable(url)) return;
    e.preventDefault();
    e.stopPropagation();
    setPreview({ name: props.name || url.split('/').pop() || url, url });
  };

  // Dropping a file from outside the browser. BlockNote handles a drop that
  // lands on the text; this covers the rest of the page, which is most of the
  // area somebody aims at — and where the browser's default is to navigate to
  // the file and throw the application away. See dropFiles.ts.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleCtx = useContext(PageTitleContext);

  useEffect(() => {
    titleCtx?.registerFocusBodyStart(() => {
      try {
        const first = editor.document?.[0];
        if (first) {
          editor.setTextCursorPosition(first, 'start');
        }
      } catch {
        // ignore
      }
    });
  }, [editor, titleCtx]);

  const onDragEnter = (e: React.DragEvent) => {
    if (!canEdit || !carriesExternalFiles(e.dataTransfer)) return;
    // dragenter/dragleave fire for every child element the pointer crosses, so
    // a plain boolean flickers the overlay away over every block. Counting
    // enter against leave is the standard fix and the only one that survives
    // nested content.
    dragDepth.current += 1;
    setDropping(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!canEdit || !carriesExternalFiles(e.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!canEdit || !carriesExternalFiles(e.dataTransfer)) return;
    // Without this the drop event never fires at all — the browser only asks
    // "may I drop here?" once per dragover, and silence means no.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!canEdit || !carriesExternalFiles(e.dataTransfer)) return;
    dragDepth.current = 0;
    setDropping(false);
    // A drop that landed on the text belongs to BlockNote: it knows WHERE
    // between the blocks the pointer was, which is the whole reason to drop
    // there rather than at the end. Doing it here as well would insert twice.
    if ((e.target as Element)?.closest?.('.bn-editor')) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    // One at a time on purpose. Uploads are size-capped and the server sizes
    // PDF extraction to the memory it believes it has; ten at once from a
    // folder drag is the shape that took an instance down once already.
    //
    // A failure does not stop the rest — dropping five and getting four plus a
    // named failure beats getting nothing.
    let added = 0;
    for (const file of files) {
      try {
        const url = await api.upload(file, pageId);
        // Appended at the end: a drop outside the text names no position.
        editor.insertBlocks(
          [{ type: blockTypeFor(file), props: { url, name: file.name } } as never],
          editor.document[editor.document.length - 1],
          'after',
        );
        added++;
      } catch (err) {
        toast((err as Error).message || t('“{name}” was not uploaded', { name: file.name }));
      }
    }
    if (added > 1) toast.success(plural(added, '{n} file added', '{n} files added'));
  };

  const handlers = useRef({ enter: onDragEnter, leave: onDragLeave, over: onDragOver, drop: onDrop });
  handlers.current = { enter: onDragEnter, leave: onDragLeave, over: onDragOver, drop: onDrop };

  // Registered on the scroller that holds cover, title, tags AND content, not
  // just on the text area — dropping onto the title is a perfectly ordinary aim
  // and it is a strip this component does not render. Native listeners rather
  // than JSX props because that element belongs to PageHeader; the listeners
  // live exactly as long as a DOCUMENT editor is mounted, so a collection page
  // (whose body is a table) never grows a drop zone that would mean nothing.
  useEffect(() => {
    const zone = scrollRef.current?.closest('.page-body');
    if (!zone) return;
    const enter = (e: Event) => handlers.current.enter(e as unknown as React.DragEvent);
    const leave = (e: Event) => handlers.current.leave(e as unknown as React.DragEvent);
    const over = (e: Event) => handlers.current.over(e as unknown as React.DragEvent);
    const drop = (e: Event) => void handlers.current.drop(e as unknown as React.DragEvent);
    zone.addEventListener('dragenter', enter);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('dragover', over);
    zone.addEventListener('drop', drop);
    return () => {
      zone.removeEventListener('dragenter', enter);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('drop', drop);
      zone.classList.remove('is-dropping');
    };
    // Registered ONCE, reading the current handlers out of a ref. Re-binding on
    // every render would swap the pair out MID-DRAG — between the dragenter
    // that shows the overlay and the dragover that accepts the drop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The outline sits on an element this component does not render, so it is set
  // rather than expressed in JSX.
  useEffect(() => {
    scrollRef.current?.closest('.page-body')?.classList.toggle('is-dropping', dropping);
  }, [dropping]);

  return (
    <div className="editor-scroll" ref={scrollRef} {...navItem('body', { keepTabOrder: true })}>
      {dropping && (
        <div className="drop-hint" aria-hidden>
          <FilePlus2 size={18} />
          {t('Drop to add to this page')}
        </div>
      )}
      <div
        className="editor-inner"
        onClickCapture={onFileClick}
        onKeyDownCapture={(e) => {
          if (e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            const surface = scrollRef.current?.querySelector('[contenteditable="true"]');
            if (surface && nothingBefore(surface)) {
              let curBlock: any = null;
              try {
                curBlock = editor.getTextCursorPosition()?.block;
              } catch {
                // ignore
              }
              const curType = curBlock?.type ?? '';
              // If it's a list item, heading, etc., let BlockNote revert it to paragraph first
              if (curType && curType !== 'paragraph') {
                return;
              }

              const content = curBlock?.content;
              const isEmpty =
                !curBlock ||
                !content ||
                (Array.isArray(content) &&
                  (content.length === 0 ||
                    content.every((c: any) => c.type === 'text' && (!c.text || c.text.length === 0))));

              e.preventDefault();
              e.stopPropagation();

              if (isEmpty) {
                try {
                  const doc = editor.document;
                  if (doc && doc.length > 1 && curBlock) {
                    editor.removeBlocks([curBlock]);
                  }
                } catch {
                  // ignore
                }

                focusKey(regionId, 'title');
                const ta = titleCtx?.titleRef?.current;
                if (ta) {
                  ta.focus();
                  const len = ta.value.length;
                  ta.setSelectionRange(len, len);
                }
                requestAnimationFrame(() => {
                  const ta = titleCtx?.titleRef?.current;
                  if (ta) {
                    ta.focus();
                    const len = ta.value.length;
                    ta.setSelectionRange(len, len);
                  }
                });
              } else {
                const blockText = inlineContentToText(content);
                const oldTitle = titleCtx?.titleRef?.current?.value ?? titleCtx?.title ?? '';
                const oldLen = oldTitle.length;
                const newTitle = oldTitle + blockText;

                titleCtx?.setTitleAndSave(newTitle);

                try {
                  const doc = editor.document;
                  if (doc && doc.length > 1 && curBlock) {
                    editor.removeBlocks([curBlock]);
                  } else if (doc && curBlock) {
                    editor.replaceBlocks([curBlock.id], [{ type: 'paragraph' }]);
                  }
                } catch {
                  // ignore
                }

                focusKey(regionId, 'title');
                const ta = titleCtx?.titleRef?.current;
                if (ta) {
                  ta.focus();
                  ta.setSelectionRange(oldLen, oldLen);
                }
                requestAnimationFrame(() => {
                  const ta = titleCtx?.titleRef?.current;
                  if (ta) {
                    ta.focus();
                    ta.setSelectionRange(oldLen, oldLen);
                  }
                });
              }
            }
          } else if (e.key === 'ArrowLeft' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            const surface = scrollRef.current?.querySelector('[contenteditable="true"]');
            if (surface && nothingBefore(surface)) {
              e.preventDefault();
              e.stopPropagation();
              if (regionId === 'content') {
                focusRegion('sidebar.tree', 0);
              }
            }
          } else if (e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            const surface = scrollRef.current?.querySelector('[contenteditable="true"]');
            if (surface && nothingBefore(surface)) {
              e.preventDefault();
              e.stopPropagation();
              focusKey(regionId, 'title');
              const ta = titleCtx?.titleRef?.current;
              if (ta) {
                ta.focus();
                const len = ta.value.length;
                ta.setSelectionRange(len, len);
              }
              requestAnimationFrame(() => {
                const ta = titleCtx?.titleRef?.current;
                if (ta) {
                  ta.focus();
                  const len = ta.value.length;
                  ta.setSelectionRange(len, len);
                }
              });
            }
          }
        }}
      >
        {/* The database block renders inside the editor and would otherwise
            not reach the page list, the tag colours or navigation. */}
        <BlockContext.Provider value={{ pagesById, tagColors, onNavigate, onOpenInNewTab, onPagesChanged, pageId: provider.pageId }}>
          <BlockNoteView editor={editor} theme={theme} editable={canEdit} slashMenu={false}>
            <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
            <SuggestionMenuController
              triggerCharacter="@"
              getItems={getMentionItems}
            />
            <SuggestionMenuController
              triggerCharacter="["
              getItems={getWikiItems}
            />
          </BlockNoteView>
        </BlockContext.Provider>
        {!structureOpen && (
          <Backlinks pageId={provider.pageId} pagesById={pagesById} onNavigate={onNavigate} onOpenInNewTab={onOpenInNewTab} />
        )}
      </div>
      {preview && (
        <FilePreview name={preview.name} url={preview.url} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

// "Linked references" — other pages that @-mention this one.
function Backlinks({
  pageId,
  pagesById,
  onNavigate,
  onOpenInNewTab,
}: {
  pageId: string;
  pagesById: Map<string, PageMeta>;
  onNavigate: (id: string | null) => void;
  onOpenInNewTab?: (id: string) => void;
}) {
  const [links, setLinks] = useState<Backlink[]>([]);
  // Refetch when the page changes or the page list updates — App rebuilds the
  // pagesById map on every reload, so depending on its identity catches new
  // links from tree changes (size-only deps would miss same-count updates).
  useEffect(() => {
    let alive = true;
    api
      .backlinks(pageId)
      .then((l) => alive && setLinks(l))
      .catch(() => { });
    return () => {
      alive = false;
    };
  }, [pageId, pagesById]);

  if (links.length === 0) return null;
  return (
    <div className="backlinks">
      {/* Same glyphs as the structure panel: this strip and the panel's
          "Linked from" show the same thing in two places, so they must not
          look like two different features. */}
      <div className="backlinks-head">
        <Link2 size={14} /> {t('Linked from')} · {links.length}
      </div>
      {links.map((l) => (
        <button
          key={l.id}
          className="backlink-item"
          onClick={(e) => openPage(e, l.id, { onNavigate, onOpenInNewTab })}
          onAuxClick={(e) => openPageAux(e, l.id, { onNavigate, onOpenInNewTab })}
        >
          <span className="tree-icon"><PageIcon icon={l.icon} size={14} fallback={<FileText size={14} />} /></span>
          {l.title || 'Untitled'}
        </button>
      ))}
    </div>
  );
}
