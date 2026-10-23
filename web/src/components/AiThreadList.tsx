import { useRef, useState } from 'react';
import { MessageCircle, MoreHorizontal, Plus, Pin } from 'lucide-react';
import { api } from '../api';
import { confirm, promptText } from '../dialog';
import { formatMoment } from '../format';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';
import AnchoredMenu from './AnchoredMenu';
import type { PageMeta } from '../types';

export interface AiThread {
  id: string;
  userId: string;
  workspaceId: string;
  pageId: string;
  pageTitle: string;
  title: string;
  msgCount: number;
  lastPreview: string;
  lastRole: string;
  lastReadAt: string;
  hasRuns: boolean;
  createdAt: string;
  updatedAt: string;
}

export function isThreadUnread(th: AiThread): boolean {
  return th.msgCount > 0 && th.lastRole === 'assistant' && (!th.lastReadAt || th.updatedAt > th.lastReadAt);
}

export function threadLink(id: string): string {
  return `${window.location.origin}/?chat=${encodeURIComponent(id)}`;
}

function lastUpdatedLabel(iso: string): string {
  return formatMoment(iso, 'dayMonth');
}

// Shared chat list: Notion-style rows (speech-bubble icon, ellipsis title,
// blue unread dot, pinned chats at top)
export default function AiThreadList(props: {
  threads: AiThread[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onMarkRead?: (id: string) => void;
  hideNew?: boolean;
}) {
  const list = props.threads;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  useMenuDismiss(menuFor !== null, menuRef, () => setMenuFor(null));

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const s = JSON.parse(localStorage.getItem('salt-pinned-chats') ?? '[]');
      if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
    } catch {
      /* localStorage unavailable */
    }
    return [];
  });

  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem('salt-pinned-chats', JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
  };

  async function copyLink(id: string) {
    setMenuFor(null);
    try {
      await navigator.clipboard.writeText(threadLink(id));
    } catch {
      /* clipboard unavailable */
    }
  }

  async function rename(th: AiThread) {
    setMenuFor(null);
    const title = await promptText(t('Rename chat'), {
      defaultValue: th.title || t('New chat'),
      confirmText: t('Rename'),
    });
    if (!title?.trim() || title.trim() === th.title) return;
    try {
      await api.renameAIThread(th.id, title.trim());
      props.onRefresh();
    } catch { /* keep old title */ }
  }

  async function markRead(th: AiThread) {
    setMenuFor(null);
    try {
      await api.markAIThreadRead(th.id);
      props.onMarkRead?.(th.id);
      props.onRefresh();
    } catch { /* ignore */ }
  }

  async function remove(th: AiThread) {
    setMenuFor(null);
    if (!(await confirm(t('Delete this chat?'), { confirmText: t('Delete'), danger: true }))) return;
    await api.deleteAIThread(th.id).catch(() => null);
    props.onDelete(th.id);
    props.onRefresh();
  }

  const pinned = list.filter((th) => pinnedIds.includes(th.id));
  const unpinned = list.filter((th) => !pinnedIds.includes(th.id));

  const renderRow = (th: AiThread, isPinned: boolean) => {
    const pageTitle = th.pageTitle || props.pagesById.get(th.pageId)?.title || '';
    const unread = isThreadUnread(th);
    return (
      <div
        key={th.id}
        className={'ai-chat-row' + (th.id === props.activeId ? ' active' : '')}
        onClick={() => props.onSelect(th.id)}
        title={th.title || t('New chat')}
      >
        <span className="ai-row-icon"><MessageCircle size={15} /></span>
        <span className="ai-row-title">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>{th.title || t('New chat')}</span>
            {isPinned && <span className="ai-pin-badge" title={t('Pinned')}>📌</span>}
          </span>
          {(pageTitle || th.lastPreview) && (
            <span className="ai-row-sub">
              {[pageTitle && `📄 ${pageTitle}`, th.lastPreview].filter(Boolean).join(' · ').slice(0, 80)}
            </span>
          )}
        </span>
        {unread && <span className="ai-unread-dot" title={t('Unread')} />}
        <span className="ai-row-menu" onClick={(e) => e.stopPropagation()} ref={menuFor === th.id ? menuRef : undefined}>
          <button
            className="ai-iconbtn"
            title={t('More')}
            onClick={() => setMenuFor(menuFor === th.id ? null : th.id)}
            type="button"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuFor === th.id && (
            <AnchoredMenu>
              <button onClick={() => { setMenuFor(null); togglePin(th.id); }}>
                📌 {isPinned ? t('Unpin chat') : t('Pin chat')}
              </button>
              <button onClick={() => void copyLink(th.id)}>
                🔗 {t('Copy link')}
              </button>
              {unread && (
                <button onClick={() => void markRead(th)}>
                  ☑ {t('Mark as read')}
                </button>
              )}
              <button onClick={() => void rename(th)}>
                ✎ {t('Rename')}
              </button>
              <button className="danger" onClick={() => void remove(th)}>
                🗑 {t('Delete')}
              </button>
              <button onClick={() => { setMenuFor(null); window.open(threadLink(th.id), '_blank', 'noopener'); }}>
                ↗ {t('Open in new tab')}
              </button>
              {th.updatedAt && (
                <div className="menu-label">
                  {t('Last updated {date}', { date: lastUpdatedLabel(th.updatedAt) })}
                </div>
              )}
            </AnchoredMenu>
          )}
        </span>
      </div>
    );
  };

  return (
    <div>
      {!props.hideNew && (
        <button className="ai-newchat" onClick={props.onNew} type="button">
          <Plus size={15} /> {t('New chat')}
        </button>
      )}
      {list.length === 0 && (
        <div className="sb-empty">{t('No chats yet')}</div>
      )}
      {pinned.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="ai-section-title">
            <Pin size={11} /> {t('Pinned')}
          </div>
          {pinned.map((th) => renderRow(th, true))}
        </div>
      )}
      {pinned.length > 0 && unpinned.length > 0 && (
        <div className="ai-section-title">
          {t('Recent')}
        </div>
      )}
      {unpinned.map((th) => renderRow(th, false))}
    </div>
  );
}

