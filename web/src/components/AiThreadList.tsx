import { useRef, useState } from 'react';
import { MessageCircle, MoreHorizontal, Plus } from 'lucide-react';
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
// blue unread dot) grouped under "Chats" / "Agents" section labels rendered
// by the caller.
export default function AiThreadList(props: {
  threads: AiThread[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onMarkRead?: (id: string) => void;
  mode?: 'chats' | 'agents';
  onNewAgent?: () => void;
  hideNew?: boolean;
}) {
  const mode = props.mode ?? 'chats';
  const list = mode === 'agents' ? props.threads.filter((th) => th.hasRuns) : props.threads;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  useMenuDismiss(menuFor !== null, menuRef, () => setMenuFor(null));

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

  return (
    <div>
      {!props.hideNew && mode === 'agents' && (
        <button className="ai-newchat" onClick={() => props.onNewAgent?.()}>
          <Plus size={15} /> {t('New agent')}
        </button>
      )}
      {!props.hideNew && mode !== 'agents' && (
        <button className="ai-newchat" onClick={props.onNew}>
          <Plus size={15} /> {t('New chat')}
        </button>
      )}
      {list.length === 0 && (
        <div className="sb-empty">{mode === 'agents' ? t('No agents yet') : t('No chats yet')}</div>
      )}
      {list.map((th) => {
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
              <span>{th.title || t('New chat')}</span>
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
              >
                <MoreHorizontal size={14} />
              </button>
              {menuFor === th.id && (
                <AnchoredMenu>
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
      })}
    </div>
  );
}
