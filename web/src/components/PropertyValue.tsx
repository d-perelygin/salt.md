import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { confirm } from '../dialog';
import type { ChecklistItem, PropDef, PropOption } from '../types';
import Portal from './Portal';
import { OPTION_HEXES, optionPalette, optionSlug } from '../selectOptions';
import { daysUntil, formatDay, formatMoment, formatNumber } from '../format';
import { showActivityFor } from './ActivityLogHost';
import { useChecklistFrac } from '../pageUiState';
import { initials, nameColor } from './CommentsPanel';
import { Check, ExternalLink, GripVertical, Link2 as LinkIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { PageIcon } from '../pageIcon';
import { openCollectionRow, peekPage, type PageOpeners } from '../pageOpen';
import { t } from '../i18n';

interface Props {
  def: PropDef;
  value: unknown;
  onChange?: (v: unknown) => void;
  onOptionsChange?: (options: PropOption[]) => void;
  readOnly?: boolean;
  compact?: boolean;
  /** Table cells pass a cap: a cell holding 22 related rows drew 22 chips
   *  under each other and made the row 500px tall, which is exactly what a
   *  table is not for. The rest is summarised as "+N" and stays one click
   *  away. Same reasoning as the one-line truncation of long text cells. */
  maxChips?: number;
  /** Open a related row when its chip is clicked — always in a new tab, never
   *  in place. Absent, chips stay static text (unknown rows always do: there
   *  is nothing readable to open). */
  onOpen?: (id: string) => void;
  /** Where the full modifier rule lives (Option peeks, the row setting
   *  decides the plain click). Preferred over onOpen wherever both openers
   *  are in scope; onOpen stays as the fallback for public views. */
  openers?: PageOpeners;
}

// idList reads a list-shaped value (relation, multiselect). A single id stored
// WITHOUT its list counts as a one-element list: agents used to write
// {"system": "abc"} and the server stored it verbatim, after which this cell
// rendered nothing at all while the row still grouped and filtered correctly —
// so the property looked switched off rather than misshapen. Writes are
// normalised on the server now; this keeps older rows readable.
export function idList(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string' && value !== '') return [value];
  // One row written as a bare value instead of a one-element list: a string is
  // the common shape, an object ({"id": …}, what a read hands back) the other.
  // The object used to fall through to nothing at all, so the cell showed no
  // chip whatsoever — not even the empty one.
  if (value && typeof value === 'object') return [value as unknown as string];
  return [];
}

function chip(opt: PropOption | undefined, fallback: string) {
  const color = opt?.color ?? '#999';
  return (
    <span className="prop-chip" style={{ background: color + '2e', color }}>
      {opt?.name ?? fallback}
    </span>
  );
}

// SelectCell is the Notion-style editor for select / multiselect cells: click to
// open a popover where you can search, create an option inline, pick each
// option's colour, or delete it. Rendered through a Portal with a viewport-
// clamped fixed position so it never runs off-screen or gets clipped by the
// scrolling table. Colour editing is a second panel (not a nested popover) so it
// stays on-screen on mobile.
//
// Shared with the workflow move dialog and the rule editor: picking from the
// same popover everywhere beats maintaining a second picker.
export function SelectCell({
  def,
  value,
  multi,
  onChange,
  onOptionsChange,
}: {
  def: PropDef;
  value: unknown;
  multi: boolean;
  onChange: (v: unknown) => void;
  onOptionsChange?: (options: PropOption[]) => void;
}) {
  // Robust against badly written schemas: when an option arrives as a bare
  // string (rather than {id, name}), `o.name.toLowerCase()` used to throw the
  // WHOLE view into its error state — one broken column made the database
  // unusable. The server normalises this on write now; this is the belt to go
  // with those braces, and it covers older data too.
  const options: PropOption[] = (def.options ?? [])
    .map((o) =>
      typeof o === 'string'
        ? ({ id: o, name: o, color: '' } as PropOption)
        : (o as PropOption),
    )
    .filter((o) => o && typeof o.name === 'string');
  const vals = multi ? idList(value) : value ? [String(value)] : [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [colorFor, setColorFor] = useState<string | null>(null); // option id being recoloured
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 240), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const spaceBelow = vh - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const below = spaceBelow >= 240 || spaceBelow >= spaceAbove;
    setPos({
      left,
      width,
      top: below ? r.bottom + 4 : undefined,
      bottom: below ? undefined : vh - r.top + 4,
      maxHeight: Math.max(200, (below ? spaceBelow : spaceAbove)),
    });
  }, [open]);

  const close = () => {
    setOpen(false);
    setColorFor(null);
    setQ('');
  };
  const selected = (id: string) => vals.includes(id);
  const query = q.trim();
  const filtered = options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));
  const exact = options.some((o) => o.name.toLowerCase() === query.toLowerCase());

  const pick = (id: string) => {
    if (multi) onChange(selected(id) ? vals.filter((v) => v !== id) : [...vals, id]);
    else {
      onChange(selected(id) ? '' : id);
      close();
    }
  };
  const create = () => {
    if (!query || !onOptionsChange) return;
    const oid = optionSlug(query, options);
    const color = OPTION_HEXES[options.length % OPTION_HEXES.length];
    onOptionsChange([...options, { id: oid, name: query, color }]);
    if (multi) {
      onChange([...vals, oid]);
      setQ('');
    } else {
      onChange(oid);
      close();
    }
  };
  const setColor = (oid: string, hex: string) => {
    onOptionsChange?.(options.map((o) => (o.id === oid ? { ...o, color: hex } : o)));
    setColorFor(null);
  };
  const remove = async (oid: string) => {
    close();
    const ok = await confirm(t('Delete option “{name}”?', { name: options.find((o) => o.id === oid)?.name ?? oid }), { confirmText: t('Delete option'), danger: true });
    if (!ok) return;
    onOptionsChange?.(options.filter((o) => o.id !== oid));
    if (multi) onChange(vals.filter((v) => v !== oid));
    else if (String(value) === oid) onChange('');
    setColorFor(null);
  };

  const editing = colorFor ? options.find((o) => o.id === colorFor) : null;

  return (
    <div className="select-cell">
      <button ref={triggerRef} className="select-cell-value" onClick={() => setOpen((o) => !o)}>
        {vals.length ? (
          vals.map((id) => <span key={id}>{chip(options.find((o) => o.id === id), id)}</span>)
        ) : (
          <span className="prop-empty">—</span>
        )}
      </button>
      {open && pos && (
        <Portal>
          <div className="select-backdrop" onClick={close} />
          <div
            className="select-menu"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
          >
            {editing ? (
              /* Colour / delete panel for a single option (keeps everything on-screen). */
              <>
                <button className="select-back" onClick={() => setColorFor(null)}>
                  ‹ {t('Back')}
                </button>
                <div className="select-editing-name">
                  <span className="prop-chip" style={{ background: editing.color + '2e', color: editing.color }}>
                    {editing.name}
                  </span>
                </div>
                <button className="tag-color-opt danger" onClick={() => remove(editing.id)}>
                  <Trash2 size={14} /> {t('Delete option')}
                </button>
                <div className="menu-label">{t('Colours')}</div>
                <div className="select-options">
                  {optionPalette().map((c) => (
                    <button key={c.hex} className="tag-color-opt" onClick={() => setColor(editing.id, c.hex)}>
                      <span className="tag-swatch" style={{ background: c.hex }} />
                      <span className="tag-color-name">{c.name}</span>
                      {editing.color === c.hex && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <input
                  className="select-search"
                  autoFocus
                  placeholder={t('Search or create…')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (query && !exact) create();
                      else if (filtered[0]) pick(filtered[0].id);
                    } else if (e.key === 'Escape') close();
                  }}
                />
                <div className="select-options">
                  {filtered.map((o) => (
                    <div key={o.id} className={'select-option' + (selected(o.id) ? ' on' : '')}>
                      <button className="select-option-main" onClick={() => pick(o.id)}>
                        <span className="prop-chip" style={{ background: o.color + '2e', color: o.color }}>
                          {o.name}
                        </span>
                        <span className="select-option-check">{selected(o.id) && <Check size={15} />}</span>
                      </button>
                      {onOptionsChange && (
                        <button
                          className="select-option-more"
                          title={t('Colour / delete')}
                          onClick={() => setColorFor(o.id)}
                        >
                          ⋯
                        </button>
                      )}
                    </div>
                  ))}
                  {query && !exact && onOptionsChange && (
                    <button className="select-create" onClick={create}>
                      <Plus size={15} /> Anlegen: „{query}"
                    </button>
                  )}
                  {filtered.length === 0 && !query && (
                    <div className="select-empty">{t('No options — type to create one.')}</div>
                  )}
                </div>
              </>
            )}
          </div>
        </Portal>
      )}
    </div>
  );
}

// Format an ISO date (YYYY-MM-DD) as a localized dd.mm.yyyy — parsed from the
// string parts (no Date() so there's no timezone shift), shown everywhere a date
// is read instead of the raw ISO.
const fmtDate = (v: string) => formatDay(v, 'date') || v;

// A due date only says something once you can see urgency without doing the
// arithmetic — that is why a Trello board reads at a glance. Overdue red,
// today and tomorrow amber, everything else quiet.
function dateUrgency(v: string): '' | ' is-overdue' | ' is-soon' {
  const days = daysUntil(v);
  if (days === null) return '';
  if (days < 0) return ' is-overdue';
  if (days <= 1) return ' is-soon';
  return '';
}

// Format a computed (rollup/formula) value for display. The server sends either
// a number or a "⚠ <message>" error string.
function formatComputed(value: unknown): { text: string; error: boolean } {
  if (typeof value === 'string' && value.startsWith('⚠')) return { text: value, error: true };
  if (typeof value === 'number') {
    // Trim floating-point noise (13.000000001) without forcing decimals on ints.
    const rounded = Math.round(value * 1e6) / 1e6;
    return { text: formatNumber(rounded), error: false };
  }
  return { text: value != null ? String(value) : '', error: false };
}

// Renders a numeric value per its numberDisplay: plain text, a progress bar, or
// a ring. Used by number props and by number-valued rollup/formula props. Falls
// back to plain text when the value isn't a finite number.
function NumberDisplay({ value, def, compact }: { value: unknown; def: PropDef; compact?: boolean }) {
  const num = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  const display = def.numberDisplay ?? 'plain';
  const label = typeof value === 'number' ? String(Math.round(value * 1e6) / 1e6) : value != null ? String(value) : '';
  if (display === 'plain' || !isFinite(num)) {
    if (!label) return compact ? null : <span className="prop-empty" />;
    return <span className="prop-number">{label}</span>;
  }
  const max = def.numberMax && def.numberMax > 0 ? def.numberMax : 100;
  const pct = Math.max(0, Math.min(100, (num / max) * 100));
  if (display === 'ring') {
    const r = 7;
    const circ = 2 * Math.PI * r;
    return (
      <span className="prop-ring" title={`${label} / ${max}`}>
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle className="prop-ring-track" cx="9" cy="9" r={r} />
          <circle
            className="prop-ring-fill"
            cx="9"
            cy="9"
            r={r}
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - pct / 100)}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span className="prop-bar-label">{label}</span>
      </span>
    );
  }
  return (
    <span className="prop-bar" title={`${label} / ${max}`}>
      <span className="prop-bar-track">
        <span className="prop-bar-fill" style={{ width: pct + '%' }} />
      </span>
      <span className="prop-bar-label">{label}</span>
    </span>
  );
}

// ---- Checklist ----
// Sub-tasks with derived progress. Deliberately NOT a number with a stored
// percentage: two truths that drift apart, and the reason a Trello-style card
// reads as "half done" is that the ticks and the bar cannot disagree.

export function checklistItems(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  // Tolerant like the select cell: an agent may write plain strings, and older
  // rows may carry items without an id.
  //
  // Empty items are KEPT. Dropping them here looked tidy and broke adding
  // entirely: a fresh sub-task starts empty, so it vanished on the very next
  // render and the + button appeared to do nothing. They are cleaned up when
  // the editor closes instead.
  return value.map((v, i) =>
    typeof v === 'string'
      ? { id: 'i' + i, text: v, done: false }
      : ({ id: String((v as ChecklistItem)?.id ?? 'i' + i), text: String((v as ChecklistItem)?.text ?? ''), done: (v as ChecklistItem)?.done === true } as ChecklistItem),
  );
}

/** The compact face of a checklist: a bar and "3/5". Used on cards and in
    table cells, where a full list would blow up the row. */
function ChecklistSummary({ items, compact }: { items: ChecklistItem[]; compact?: boolean }) {
  // A half-typed sub-task must not dilute the percentage, so the summary counts
  // only items that say something.
  const named = items.filter((i) => i.text.trim() !== '');
  const total = named.length;
  const done = named.filter((i) => i.done).length;
  if (!total) return compact ? null : <span className="prop-empty" />;
  const pct = Math.round((done / total) * 100);
  // The label flips, everywhere at once, between a percentage and the bare
  // count: one tap on it is the switch. It stops the click there, or the tap
  // would also open the row (or the list) underneath it.
  const [frac, toggleFrac] = useChecklistFrac();
  return (
    <span className="prop-bar prop-checklist-sum" title={frac ? `${pct}%` : `${done} / ${total}`}>
      <span className="prop-bar-track">
        <span className={'prop-bar-fill' + (done === total ? ' is-full' : '')} style={{ width: pct + '%' }} />
      </span>
      <button
        type="button"
        className="prop-bar-label prop-bar-toggle"
        onClick={(e) => {
          e.stopPropagation();
          toggleFrac();
        }}
      >
        {frac ? `${done} / ${total}` : `${pct}%`}
      </button>
    </span>
  );
}

function ChecklistValue({ value, onChange, readOnly, compact }: Props) {
  const items = checklistItems(value);
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const focusIdRef = useRef<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const ro = readOnly || !onChange;

  const write = (next: ChecklistItem[]) => onChange!(next.length ? next : null);

  const close = () => {
    // Closing is where empty rows go — they exist so you can type in
    // them, not so they end up in the data.
    const named = items.filter((i) => i.text.trim() !== '');
    if (named.length !== items.length) write(named);
    setOpen(false);
    setDragId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, items]);

  useEffect(() => {
    if (focusIdRef.current) {
      const el = inputRefs.current.get(focusIdRef.current);
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
      focusIdRef.current = null;
    }
  }, [items, open]);

  // Read-only cells and the collapsed state show the summary; the list itself
  // only appears once someone opens it, so a table row stays one line high.
  if (ro || !open) {
    const summary = <ChecklistSummary items={items} compact={compact} />;
    if (ro) return summary;
    return (
      <span
        className="prop-checklist-toggle"
        onClick={() => {
          if (items.length === 0) {
            const firstId = 'i' + Date.now().toString(36) + '0';
            focusIdRef.current = firstId;
            write([{ id: firstId, text: '', done: false }]);
          }
          setOpen(true);
        }}
      >
        {items.length ? summary : <span className="prop-empty">{t('+ Sub-task')}</span>}
      </span>
    );
  }

  const toggle = (id: string) => write(items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  const setText = (id: string, text: string) => write(items.map((i) => (i.id === id ? { ...i, text } : i)));
  const remove = (id: string) => write(items.filter((i) => i.id !== id));

  const add = (afterIndex?: number) => {
    const newId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    focusIdRef.current = newId;
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < items.length) {
      const next = [...items];
      next.splice(afterIndex + 1, 0, { id: newId, text: '', done: false });
      write(next);
    } else {
      write([...items, { id: newId, text: '', done: false }]);
    }
  };

  const moveItem = (id: string, targetId: string, after: boolean) => {
    const source = items.findIndex((i) => i.id === id);
    const target = items.findIndex((i) => i.id === targetId);
    if (source < 0 || target < 0 || source === target) return;
    const next = [...items];
    const [item] = next.splice(source, 1);
    next.splice(target - (source < target ? 1 : 0) + Number(after), 0, item);
    write(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, it: ChecklistItem, index: number) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      toggle(it.id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!it.text.trim()) {
        close();
      } else {
        add(index);
      }
    } else if (e.key === 'Backspace' && it.text === '') {
      e.preventDefault();
      if (items.length > 1) {
        const targetIndex = index > 0 ? index - 1 : index + 1;
        focusIdRef.current = items[targetIndex]?.id ?? null;
      }
      remove(it.id);
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      if (index > 0) {
        focusIdRef.current = it.id;
        moveItem(it.id, items[index - 1].id, false);
      }
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (index < items.length - 1) {
        focusIdRef.current = it.id;
        moveItem(it.id, items[index + 1].id, true);
      }
    } else if (e.key === 'ArrowUp') {
      if (index > 0) {
        const prevEl = inputRefs.current.get(items[index - 1].id);
        if (prevEl) {
          e.preventDefault();
          prevEl.focus();
        }
      }
    } else if (e.key === 'ArrowDown') {
      if (index < items.length - 1) {
        const nextEl = inputRefs.current.get(items[index + 1].id);
        if (nextEl) {
          e.preventDefault();
          nextEl.focus();
        }
      }
    }
  };

  return (
    <div className="prop-checklist" ref={boxRef}>
      <ChecklistSummary items={items} />
      {items.map((it, idx) => (
        <div
          key={it.id}
          className={
            'pcl-item' +
            (it.done ? ' is-done' : '') +
            (dragId === it.id ? ' pcl-dragging' : '') +
            (dropTarget?.id === it.id ? (dropTarget.after ? ' pcl-drop-after' : ' pcl-drop-before') : '')
          }
          onDragOver={(e) => {
            if (!dragId || dragId === it.id) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            const bounds = e.currentTarget.getBoundingClientRect();
            setDropTarget({
              id: it.id,
              after: e.clientY > bounds.top + bounds.height / 2,
            });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              if (dropTarget?.id === it.id) setDropTarget(null);
            }
          }}
          onDrop={(e) => {
            if (!dragId || dragId === it.id) return;
            e.preventDefault();
            e.stopPropagation();
            const bounds = e.currentTarget.getBoundingClientRect();
            moveItem(dragId, it.id, e.clientY > bounds.top + bounds.height / 2);
            setDragId(null);
            setDropTarget(null);
          }}
        >
          <span
            className="pcl-drag-handle"
            draggable
            title={t('Drag to reorder')}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', it.id);
              setDragId(it.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropTarget(null);
            }}
          >
            <GripVertical size={13} />
          </span>
          <input type="checkbox" checked={it.done} onChange={() => toggle(it.id)} />
          <input
            ref={(el) => {
              if (el) inputRefs.current.set(it.id, el);
              else inputRefs.current.delete(it.id);
            }}
            className="pcl-text"
            value={it.text}
            placeholder={t('Sub-task')}
            onChange={(e) => setText(it.id, e.target.value)}
            onKeyDown={(e) => onKeyDown(e, it, idx)}
          />
          <button type="button" className="pcl-del" title={t('Delete')} onClick={() => remove(it.id)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <div className="pcl-actions">
        <button type="button" className="pcl-add" onClick={() => add()}>
          <Plus size={12} /> {t('Sub-task')}
        </button>
        <button type="button" className="pcl-add" onClick={close}>
          {t('Done')}
        </button>
      </div>
    </div>
  );
}

// ---- Person ----
// Members of the workspaces this browser can see, by id AND by name, so a
// person value written as a name (by hand or by an agent) still finds its face.
// One request per workspace, shared by every cell — a table with 200 person
// cells must not make 200 calls.
export type Member = { userId: string; name: string; color: string; avatar: string };
let memberCache: Promise<Member[]> | null = null;

export function loadMembers(): Promise<Member[]> {
  if (!memberCache) {
    memberCache = api
      .listWorkspaces()
      .then((ws) => Promise.all(ws.map((w) => api.listMembers(w.id).catch(() => []))))
      .then((lists) => {
        const byID = new Map<string, Member>();
        for (const m of lists.flat()) {
          byID.set(m.userId, { userId: m.userId, name: m.name, color: m.color, avatar: m.avatar });
        }
        return [...byID.values()];
      })
      .catch(() => [] as Member[]);
  }
  return memberCache;
}

/** The chip: a face plus the name. Matches by id first, then by name, so a
    value an agent wrote as plain text still finds its person; an unknown value
    stays readable text rather than disappearing. */
function PersonChip({ raw, members }: { raw: string; members: Member[] }) {
  const lower = raw.toLowerCase();
  const hit = members.find((m) => m.userId === raw) ?? members.find((m) => m.name.toLowerCase() === lower);
  const name = hit?.name ?? raw;
  return (
    <span className="prop-person" title={name}>
      <span
        className="cp-avatar prop-person-av"
        style={{ background: hit?.avatar ? 'transparent' : hit?.color || nameColor(name) }}
      >
        {hit?.avatar ? <img src={hit.avatar} alt="" /> : initials(name)}
      </span>
      <span className="prop-person-name">{name}</span>
    </span>
  );
}

/** The people on a card, as overlapping faces in the top right corner (W126).
 *
 *  Cards used to print every person field as a full-name chip, one per line —
 *  so the same colleague appeared two or three times (once per field) and ate
 *  three rows before the first real fact. The stack dedupes by person, not by
 *  field: who is on this card is one question, however many fields answer it.
 *  The name lives in the tooltip; the face is enough to recognise. */
export function PersonStack({ values, max = 3 }: { values: string[]; max?: number }) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let alive = true;
    void loadMembers().then((m) => alive && setMembers(m));
    return () => {
      alive = false;
    };
  }, []);

  const people: { key: string; name: string; color: string; avatar: string }[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const lower = v.toLowerCase();
    const hit = members.find((m) => m.userId === v) ?? members.find((m) => m.name.toLowerCase() === lower);
    const name = hit?.name ?? v;
    // Dedupe on the resolved person: the same human written once as an id and
    // once as a name is one face, not two.
    const key = hit?.userId ?? name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ key, name, color: hit?.color || nameColor(name), avatar: hit?.avatar ?? '' });
  }
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.slice(max);
  return (
    <span className="person-stack" title={people.map((p) => p.name).join(', ')}>
      {shown.map((p) => (
        <span
          key={p.key}
          className="cp-avatar person-stack-av"
          style={{ background: p.avatar ? 'transparent' : p.color }}
          title={p.name}
        >
          {p.avatar ? <img src={p.avatar} alt="" /> : initials(p.name)}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="cp-avatar person-stack-av person-stack-more" title={rest.map((p) => p.name).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** A person cell: pick a colleague from a list, or type a name for somebody
    without an account.
 *
 *  The first version was a free-text field, and that was a dead end twice over:
 *  an empty cell rendered as a 0×0 span (nothing to click, so the whole column
 *  looked broken), and even once open it asked you to type a colleague's name
 *  exactly — with the roster sitting right there. Picking stores the USER ID, so
 *  the cell follows a rename; free text is kept as a fallback and stored as
 *  typed.
 *
 *  A property may allow several people and may name who can be picked (#11).
 *  The value is then a list; either shape is READ either way, because a
 *  property switched between one and several keeps what its rows already hold.
 *  With a list of who can be picked, nobody else can be typed in either. */
function PersonValue({ def, value, onChange, readOnly, compact }: Props) {
  const values = (Array.isArray(value) ? value : [value])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  const multiple = !!def.personMultiple;
  const [members, setMembers] = useState<Member[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const ro = readOnly || !onChange;

  useEffect(() => {
    let alive = true;
    void loadMembers().then((m) => alive && setMembers(m));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // One face and a name, or for several people one stack of faces — a cell
  // that printed every name would grow a line per person.
  const shown =
    values.length === 0 ? null : values.length === 1 ? (
      <PersonChip raw={values[0]} members={members} />
    ) : (
      <PersonStack values={values} max={4} />
    );
  if (ro || compact) return shown;

  const pool = def.personPool?.length ? new Set(def.personPool) : null;
  const candidates = pool ? members.filter((m) => pool.has(m.userId)) : members;
  const q = query.trim().toLowerCase();
  const filtered = candidates.filter((m) => m.name.toLowerCase().includes(q));
  const holds = (m: Member) => values.includes(m.userId) || values.includes(m.name);
  const write = (next: string[]) => {
    if (multiple) onChange!(next.length ? next : null);
    else onChange!(next[0] || null);
  };
  const choose = (v: string) => {
    if (!multiple) {
      write(v ? [v] : []);
      setOpen(false);
    } else {
      const m = members.find((x) => x.userId === v);
      const on = m ? holds(m) : values.includes(v);
      write(on ? values.filter((x) => x !== v && (!m || x !== m.name)) : [...values, v]);
    }
    setQuery('');
  };

  return (
    <div className="relation-value" ref={boxRef}>
      {/* Always a real hit target: an empty cell says "＋ Person" instead of
          being an invisible nothing. */}
      <button type="button" className="relation-open" onClick={() => setOpen((v) => !v)}>
        {shown ?? <span className="prop-empty">{t('＋ Person')}</span>}
      </button>
      {open && (
        <div className="menu relation-menu">
          <input
            className="prop-input"
            autoFocus
            placeholder={pool ? t('Search…') : t('Search or type a name…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the single match, else what was typed — so somebody
              // without an account can be entered without leaving the keyboard.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (filtered.length === 1) choose(filtered[0].userId);
              else if (query.trim() && !pool) choose(query.trim());
            }}
          />
          <div className="relation-options">
            {filtered.map((m) => (
              <button
                key={m.userId}
                type="button"
                className={'relation-option' + (holds(m) ? ' on' : '')}
                onClick={() => choose(m.userId)}
              >
                <span className="relation-check">{holds(m) ? '✓' : ''}</span>
                <PersonChip raw={m.userId} members={members} />
              </button>
            ))}
            {q && !pool && !filtered.some((m) => m.name.toLowerCase() === q) && (
              <button type="button" className="relation-option" onClick={() => choose(query.trim())}>
                <span className="relation-check" />
                {t('Use “{name}”', { name: query.trim() })}
              </button>
            )}
            {!candidates.length && !q && <div className="relation-empty">{t('No members')}</div>}
            {values.length > 0 && (
              <button
                type="button"
                className="relation-option danger"
                onClick={() => {
                  write([]);
                  setOpen(false);
                }}
              >
                <span className="relation-check" />
                {t('Remove')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Relation picker ----
// Rows of the target collection are fetched once per collection and shared
// across every relation cell via a module-level cache, so a table with many
// relation cells doesn't issue one request per cell.
export type RelOption = { id: string; title: string; icon: string };
const relCache = new Map<string, Promise<RelOption[]>>();

// Exported because the board groups by relation too, and it must show the same
// titles the cells show — loaded once through the same cache rather than
// fetched a second time per view.
export function loadRelationOptions(colId: string, force = false): Promise<RelOption[]> {
  if (force || !relCache.has(colId)) {
    const p = api
      .collectionRows(colId, { limit: 500 })
      .then((r) => r.rows.map((x) => ({ id: x.id, title: x.title, icon: x.icon })))
      .catch(() => {
        // Forget the failure. Caching it meant one hiccup — a restart mid-load,
        // a dropped connection — left every chip in every relation cell reading
        // "Untitled" until the tab was reloaded, because the empty list stayed
        // in the cache and nothing ever asked again.
        if (relCache.get(colId) === p) relCache.delete(colId);
        return [] as RelOption[];
      });
    relCache.set(colId, p);
  }
  return relCache.get(colId)!;
}

function RelationValue({ def, value, onChange, readOnly, compact, maxChips, onOpen, openers }: Props) {
  const targetId = def.relationCollection;
  const ids = idList(value);
  const [options, setOptions] = useState<RelOption[]>([]);
  // Whether the titles have ARRIVED, which is a different question from whether
  // there are any. It separates "still coming" from "asked, and this row was not
  // in the answer" — two states that both used to render as the word "Untitled".
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const ro = readOnly || !onChange;

  useEffect(() => {
    if (!targetId) return;
    let alive = true;
    void loadRelationOptions(targetId).then((o) => {
      if (!alive) return;
      setOptions(o);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [targetId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Three cases, and the middle one is the whole point:  //
  //   in the list with a title   → the title
  //   in the list with none      → "Untitled", which is then TRUE of that row
  //   not in the list at all     → '' — we do not know, and say so
  //
  // The last case used to fall in with the second and read "Untitled", which is
  // a statement about a row we have never seen. It covers more than the loading
  // window: a target collection past the 500 rows fetched here, a row somebody
  // may not read, a relation left pointing at something deleted. None of those
  // is a row called Untitled.
  // A relation value is a page id. Older rows and hand-written ones may hold
  // something else — the object a read handed back ({"id": …}), or a title —
  // and reading one of those must not throw: a value nobody can parse is a
  // value to SHOW, not a reason to take the whole view down. (It did throw:
  // `value.trim is not a function` on every view holding one.)
  const asText = (raw: unknown): string => {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return String(raw);
    if (raw && typeof raw === 'object') {
      const o = raw as { id?: unknown; title?: unknown };
      if (typeof o.id === 'string' && o.id) return o.id;
      if (typeof o.title === 'string' && o.title) return o.title;
      try {
        return JSON.stringify(raw) ?? '';
      } catch {
        return '';
      }
    }
    return '';
  };

  // A value that is not an id but matches exactly ONE row's title is resolved
  // to that row. The stored value is wrong, but the row it names is not
  // ambiguous, and hiding a working relation behind a data problem helps
  // nobody. Two rows with the same title stay unresolved, because there is no
  // answer to give.
  const rowFor = (raw: unknown): RelOption | undefined => {
    const value = asText(raw);
    const byId = options.find((o) => o.id === value);
    if (byId) return byId;
    const wanted = value.trim().toLowerCase();
    if (!wanted) return undefined;
    const byTitle = options.filter((o) => {
      const title = (o.title || '').trim().toLowerCase();
      return title !== '' && title === wanted;
    });
    return byTitle.length === 1 ? byTitle[0] : undefined;
  };

  if (!targetId) return <span className="prop-empty">{t('No target')}</span>;

  // A table cell shows the first few and counts the rest. Everything is still
  // there — the picker below lists all of them, and the row itself holds the
  // full column.
  const shown = maxChips && ids.length > maxChips ? ids.slice(0, maxChips) : ids;
  const hidden = ids.length - shown.length;

  // A row's icon is any of the four kinds a page icon can be, so it goes
  // through PageIcon like everywhere else. Printed raw, a Lucide or MDI icon
  // arrived as the literal text "lucide:PhoneCall" — visible in the picker on
  // every row whose icon was not an emoji.
  // Clicking a chip EDITS the field (opens the picker below), the way URL
  // chips edit on click: a filled cell must stay correctable. The icon beside
  // the chip opens the row, like the URL chip's icon opens the link. The two
  // are siblings, never nested: a button in a button is invalid HTML, and on
  // cards a long title hid the hover affordance completely.
  const openPicker = () => {
    if (!open && targetId) void loadRelationOptions(targetId, true).then(setOptions);
    setOpen(true);
  };
  // An unreadable row has nothing to open, and a spot with no opener at all
  // (a static render) keeps every chip as plain text. Only a writable,
  // non-compact cell can edit: on cards the picker is not rendered at all.
  const canOpen = onOpen !== undefined || openers !== undefined;
  const canEdit = !ro && !compact;
  const chips = (
    <span className="prop-multi">
      {shown.map((raw, i) => {
        const value = asText(raw);
        const row = rowFor(raw);
        // Nothing resolves: the chip says what the cell actually holds rather
        // than showing an empty box. The tooltip says the rest.
        const title = row ? row.title || t('Untitled') : loaded ? value : '';
        const inner = (
          <>
            {row?.icon && (
              <span className="relation-icon">
                <PageIcon icon={row.icon} size={14} />
              </span>
            )}
            {title}
          </>
        );
        const cls =
          'prop-chip relation-chip' + (row ? '' : loaded ? ' is-unknown' : ' is-pending');
        const tip = row ? title : loaded ? t('This row is not readable from here.') : undefined;
        const chipStyle = { background: '#3b6fb52e', color: '#3b6fb5' } as const;
        // Unknown rows stay plain text: there is nothing to open.
        if (!row || !canOpen) {
          return (
            <span key={i} className={cls} title={tip} style={chipStyle}>
              {inner}
            </span>
          );
        }
        const openRow = (e: React.MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          if (openers) openCollectionRow(e, row.id, openers);
          else if (onOpen && !peekPage(e, row.id)) onOpen(row.id);
        };
        // No edit affordance here (a card, or a read-only spot): the chip
        // itself opens the row.
        if (!canEdit) {
          return (
            <button
              key={i}
              type="button"
              className={cls}
              title={tip}
              style={chipStyle}
              onClick={openRow}
              onAuxClick={(e) => {
                e.preventDefault();
                openRow(e);
              }}
            >
              {inner}
            </button>
          );
        }
        return (
          <span key={i} className="relation-chip-wrap" title={tip}>
            <button
              type="button"
              className={cls}
              style={chipStyle}
              aria-label={t('Edit') + ': ' + def.name}
              onClick={(e) => {
                e.stopPropagation();
                openPicker();
              }}
            >
              {inner}
            </button>
            <button
              type="button"
              className="relation-open-btn"
              aria-label={t('Open row')}
              title={t('Open row')}
              onClick={openRow}
              onAuxClick={(e) => {
                e.preventDefault();
                openRow(e);
              }}
            >
              <ExternalLink size={12} />
            </button>
          </span>
        );
      })}
      {hidden > 0 && (
        <span
          className="prop-chip relation-more"
          title={ids.map((v) => rowFor(v)?.title ?? asText(v)).filter(Boolean).join(', ')}
        >
          {t('+{n} more', { n: hidden })}
        </span>
      )}
    </span>
  );

  if (ro) return ids.length ? chips : null;
  if (compact) return ids.length ? chips : null;

  const toggle = (id: string) => {
    onChange!(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };
  const filtered = options.filter((o) =>
    (o.title || 'Untitled').toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="relation-value" ref={boxRef}>
      {ids.length ? (
        chips
      ) : (
        <button
          type="button"
          className="relation-open"
          onClick={() => {
            if (!open && targetId) void loadRelationOptions(targetId, true).then(setOptions);
            setOpen((v) => !v);
          }}
        >
          <span className="prop-empty">{t('＋ Link')}</span>
        </button>
      )}
      {open && (
        <div className="menu relation-menu">
          <input
            className="prop-input"
            autoFocus
            placeholder={t('Search…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="relation-options">
            {filtered.length === 0 && <div className="relation-empty">{t('No rows')}</div>}
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                className={'relation-option' + (ids.includes(o.id) ? ' on' : '')}
                onClick={() => toggle(o.id)}
              >
                <span className="relation-check">{ids.includes(o.id) ? '✓' : ''}</span>
                {o.icon && (
                  <span className="relation-icon">
                    <PageIcon icon={o.icon} size={16} />
                  </span>
                )}
                {o.title || 'Untitled'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PropertyValue({
  def,
  value,
  onChange,
  onOptionsChange,
  readOnly,
  compact,
  maxChips,
  onOpen,
  openers,
}: Props) {
  const [editing, setEditing] = useState(false);
  const ro = readOnly || !onChange;

  switch (def.type) {
    case 'relation':
      return (
        <RelationValue
          def={def}
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          compact={compact}
          maxChips={maxChips}
          onOpen={onOpen}
          openers={openers}
        />
      );
    // A backrelation IS a relation to read — same ids, same titles, same
    // chips. It is only computed rather than typed in, so it never takes an
    // onChange: editing happens on the side that owns the relation. Without
    // this case it fell through to the text renderer and showed raw ids.
    case 'backrelation':
      return (
        <RelationValue
          def={{ ...def, relationCollection: def.backrelationCollection ?? '' }}
          value={value}
          readOnly
          compact={compact}
          maxChips={maxChips}
          onOpen={onOpen}
          openers={openers}
        />
      );
    case 'lastActivity': {
      // Computed on read from the row's last-changed stamp and the newest audit
      // entry — never stored, so it cannot go stale the way a field somebody has
      // to remember to set does. That is the whole point: it moves by itself when
      // anyone, person or agent, touches the row.
      //
      // The row id rides along in the value, which is what lets the cell open the
      // log for this row: a property renderer is handed a value, not a row.
      const v = (value ?? {}) as { at?: string; by?: string; page?: string; title?: string };
      if (!v.at) return compact ? null : <span className="prop-empty">—</span>;
      if (!v.page) {
        return (
          <span className="prop-computed">
            {formatMoment(v.at, 'datetime')}
            {v.by ? <span className="prop-activity-by"> · {v.by}</span> : null}
          </span>
        );
      }
      return (
        <button
          type="button"
          className="prop-computed prop-activity"
          title={t('Show what happened to this row')}
          onClick={(ev) => {
            ev.stopPropagation();
            showActivityFor(v.page!, v.title);
          }}
        >
          {formatMoment(v.at, 'datetime')}
          {v.by ? <span className="prop-activity-by"> · {v.by}</span> : null}
        </button>
      );
    }
    case 'rollup':
    case 'formula': {
      // Computed server-side; always read-only. Renders the number or an
      // inline "⚠ …" for a bad formula (division by zero, cycle, …).
      const { text, error } = formatComputed(value);
      if (!text) return compact ? null : <span className="prop-empty">—</span>;
      // A numeric computed value can display as a progress bar/ring too.
      if (!error && (def.numberDisplay === 'bar' || def.numberDisplay === 'ring') && isFinite(Number(value))) {
        return <NumberDisplay value={value} def={def} compact={compact} />;
      }
      return <span className={'prop-computed' + (error ? ' error' : '')}>{text}</span>;
    }
    case 'select': {
      const opt = def.options?.find((o) => o.id === value);
      if (ro) return value ? chip(opt, String(value)) : null;
      return (
        <SelectCell
          def={def}
          value={value}
          multi={false}
          onChange={onChange!}
          onOptionsChange={onOptionsChange}
        />
      );
    }
    case 'multiselect': {
      const vals = idList(value);
      if (compact || ro) {
        return (
          <span className="prop-multi">
            {vals.map((id) => chip(def.options?.find((o) => o.id === id), id))}
          </span>
        );
      }
      return (
        <SelectCell
          def={def}
          value={value}
          multi
          onChange={onChange!}
          onOptionsChange={onOptionsChange}
        />
      );
    }
    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={value === true}
          disabled={ro}
          onChange={(e) => onChange?.(e.target.checked)}
        />
      );
    case 'checklist':
      return <ChecklistValue def={def} value={value} onChange={onChange} readOnly={readOnly} compact={compact} />;
    case 'number': {
      const display = def.numberDisplay ?? 'plain';
      if (ro) return <NumberDisplay value={value} def={def} compact={compact} />;
      // A bar/ring number shows the visual until clicked, then edits the raw
      // value (like the text cell). A plain number stays an always-on input.
      if (display !== 'plain' && !editing) {
        return (
          <span className="prop-num-editable" onClick={() => setEditing(true)}>
            <NumberDisplay value={value} def={def} compact={compact} />
          </span>
        );
      }
      return (
        <input
          className="prop-input"
          type="number"
          autoFocus={display !== 'plain'}
          value={(value as number) ?? ''}
          onChange={(e) => onChange!(e.target.value === '' ? null : Number(e.target.value))}
          onBlur={display !== 'plain' ? () => setEditing(false) : undefined}
        />
      );
    }
    case 'date':
      if (ro)
        return value ? (
          <span className={'prop-date' + dateUrgency(String(value))}>{fmtDate(String(value))}</span>
        ) : compact ? null : (
          <span className="prop-empty" />
        );
      return (
        <input
          className="prop-input prop-input-date"
          type="date"
          value={(value as string) || ''}
          onChange={(e) => onChange!(e.target.value)}
          onClick={(e) => {
            // The whole field opens the calendar: natively only the icon does
            // that, and clicking the text merely starts segment editing.
            // Typing still works — Tab into the field, or Escape the picker.
            try {
              e.currentTarget.showPicker?.();
            } catch {
              /* already open, or no picker on this browser — it still edits */
            }
          }}
        />
      );
    case 'url': {
      // Without a case of its own a URL landed in the text branch and sat on
      // the card as a full line of raw text ("https://trello.com/c/yksGXxLh")
      // — on a board that is pure noise. The host is what is shown, the full
      // address is what is opened.
      const href = String(value ?? '').trim();
      const full = href.includes('://') ? href : 'https://' + href;
      let label = href;
      try {
        const u = new URL(href.includes('://') ? href : 'https://' + href);
        label = u.hostname.replace(/^www\./, '');
      } catch {
        /* not a valid URL — then leave it unshortened */
      }
      const chip = href ? (
        <a
          className="prop-url-chip"
          href={full}
          target="_blank"
          rel="noopener noreferrer"
          title={href}
          onClick={(e) => e.stopPropagation()}
        >
          <LinkIcon size={11} />
          {label}
        </a>
      ) : compact ? null : (
        <span className="prop-empty">—</span>
      );
      if (ro) return chip;
      if (compact) return chip;
      if (!editing) {
        // A filled chip is a real link, so a plain click on it opens the URL
        // and can never mean "edit". Editing is entered through the pencil
        // (revealed on hover), a double-click, or a click on an empty value.
        return (
          <span
            className="prop-url-editable"
            title={href || t('Click to edit')}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <span
              onClick={
                href
                  ? undefined
                  : (e) => {
                      e.stopPropagation();
                      setEditing(true);
                    }
              }
            >
              {chip}
            </span>
            <button
              type="button"
              className="prop-url-edit-btn"
              title={t('Edit link')}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              <Pencil size={12} />
            </button>
          </span>
        );
      }
      return (
        <input
          className="prop-input"
          autoFocus
          defaultValue={href}
          placeholder="https://…"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value.trim() !== href) onChange!(e.target.value.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      );
    }
    case 'person':
      return <PersonValue def={def} value={value} onChange={onChange} readOnly={readOnly} compact={compact} />;
    case 'text':
    default:
      if (compact) return value ? <span className="prop-text-chip">{String(value)}</span> : null;
      if (ro || !editing) {
        return (
          <span
            className="prop-text"
            onClick={ro ? undefined : () => setEditing(true)}
          >
            {value ? String(value) : <span className="prop-empty" />}
          </span>
        );
      }
      return (
        <input
          className="prop-input"
          autoFocus
          defaultValue={(value as string) || ''}
          onBlur={(e) => {
            setEditing(false);
            onChange!(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      );
  }
}
