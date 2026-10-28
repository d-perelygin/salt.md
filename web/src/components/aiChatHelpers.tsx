import { Fragment } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { toast } from '../toast';
import type { CollectionConfig, PageMeta } from '../types';

export interface CollectionTemplatePreset {
  id: 'tasks' | 'projects' | 'kb';
  badge: string;
  tone: 'green' | 'blue' | 'purple';
  label: () => string;
  title: () => string;
  icon: string;
  config: () => Partial<CollectionConfig>;
}

export const COLLECTION_PRESETS: CollectionTemplatePreset[] = [
  {
    id: 'tasks',
    badge: '✓',
    tone: 'green',
    label: () => t('Tasks Tracker'),
    title: () => t('Tasks Tracker'),
    icon: '✅',
    config: () => ({
      schema: [
        {
          id: 'status',
          name: t('Status'),
          type: 'select',
          options: [
            { id: 'todo', name: t('Todo'), color: 'gray' },
            { id: 'doing', name: t('In progress'), color: 'blue' },
            { id: 'done', name: t('Done'), color: 'green' },
          ],
        },
        {
          id: 'priority',
          name: t('Priority'),
          type: 'select',
          options: [
            { id: 'low', name: t('Low'), color: 'gray' },
            { id: 'med', name: t('Medium'), color: 'amber' },
            { id: 'high', name: t('High'), color: 'red' },
          ],
        },
        { id: 'assignee', name: t('Assignee'), type: 'person' },
        { id: 'due', name: t('Due'), type: 'date' },
      ],
      views: [
        { id: 'v_table', name: t('Table'), type: 'table', filters: [], sort: null },
        { id: 'v_board', name: t('Board'), type: 'board', groupBy: 'status', filters: [], sort: null },
      ],
    }),
  },
  {
    id: 'projects',
    badge: '◎',
    tone: 'blue',
    label: () => t('Projects'),
    title: () => t('Projects'),
    icon: '🚀',
    config: () => ({
      schema: [
        {
          id: 'status',
          name: t('Status'),
          type: 'select',
          options: [
            { id: 'planned', name: t('Planned'), color: 'gray' },
            { id: 'active', name: t('Active'), color: 'blue' },
            { id: 'completed', name: t('Completed'), color: 'green' },
          ],
        },
        { id: 'owner', name: t('Owner'), type: 'person' },
        { id: 'start', name: t('Start date'), type: 'date' },
        { id: 'end', name: t('End date'), type: 'date' },
      ],
      views: [
        { id: 'v_table', name: t('Table'), type: 'table', filters: [], sort: null },
        { id: 'v_board', name: t('Board'), type: 'board', groupBy: 'status', filters: [], sort: null },
      ],
    }),
  },
  {
    id: 'kb',
    badge: '✦',
    tone: 'purple',
    label: () => t('Knowledge Base'),
    title: () => t('Knowledge Base'),
    icon: '📚',
    config: () => ({
      schema: [
        {
          id: 'category',
          name: t('Category'),
          type: 'select',
          options: [
            { id: 'guide', name: t('Guide'), color: 'blue' },
            { id: 'reference', name: t('Reference'), color: 'purple' },
            { id: 'faq', name: t('FAQ'), color: 'green' },
          ],
        },
        {
          id: 'status',
          name: t('Status'),
          type: 'select',
          options: [
            { id: 'draft', name: t('Draft'), color: 'gray' },
            { id: 'published', name: t('Published'), color: 'green' },
          ],
        },
        { id: 'summary', name: t('Summary'), type: 'text' },
      ],
      views: [
        { id: 'v_table', name: t('Table'), type: 'table', filters: [], sort: null },
        { id: 'v_board', name: t('Board'), type: 'board', groupBy: 'category', filters: [], sort: null },
      ],
    }),
  },
];

export async function applyCollectionPreset(
  preset: CollectionTemplatePreset,
  currentCollectionId?: string,
): Promise<string | null> {
  try {
    let targetId = currentCollectionId;
    if (targetId) {
      await api.updatePage(targetId, { title: preset.title(), icon: preset.icon });
      await api.putCollection(targetId, preset.config());
      window.dispatchEvent(new CustomEvent('salt:rows', { detail: targetId }));
    } else {
      const created = await api.createPage(null, preset.title(), 'collection');
      targetId = created.id;
      await api.updatePage(targetId, { icon: preset.icon });
      await api.putCollection(targetId, preset.config());
      window.dispatchEvent(new CustomEvent('salt:navigate', { detail: targetId }));
    }
    toast.info(t('Template applied'));
    return targetId ?? null;
  } catch {
    toast(t('The template could not be used'));
    return null;
  }
}

export async function instantiateCollectionTemplate(templateId: string): Promise<string | null> {
  try {
    const r = await api.duplicatePage(templateId, true);
    window.dispatchEvent(new CustomEvent('salt:navigate', { detail: r.id }));
    toast.info(t('Template applied'));
    return r.id;
  } catch {
    toast(t('The template could not be used'));
    return null;
  }
}

// Renders text with @PageTitle highlighted as a clickable .page-link pill
// whenever a matching non-trashed page exists in pagesById.
export function renderTextWithMentions(
  text: string,
  pagesById?: Map<string, PageMeta>,
  interactive = true,
): React.ReactNode {
  if (!text || !pagesById || pagesById.size === 0 || !text.includes('@')) return text;
  const pages = [...pagesById.values()]
    .filter((p) => !p.trashed && (p.title || '').trim().length > 0)
    .sort((a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0));
  if (pages.length === 0) return text;

  const out: React.ReactNode[] = [];
  let idx = 0;
  let key = 0;
  while (idx < text.length) {
    const at = text.indexOf('@', idx);
    if (at === -1) {
      out.push(text.slice(idx));
      break;
    }
    if (at > idx) out.push(text.slice(idx, at));
    const rest = text.slice(at + 1);
    let matched: PageMeta | undefined;
    for (const p of pages) {
      const title = p.title || '';
      if (title && rest.startsWith(title)) {
        const after = rest[title.length];
        if (!after || /[\s.,!?;:)\]]/.test(after)) {
          matched = p;
          break;
        }
      }
    }
    if (matched) {
      const title = matched.title || t('Untitled');
      const pid = matched.id;
      out.push(
        interactive ? (
          <button
            key={key++}
            type="button"
            className="page-link ai-mention-link"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(
                new CustomEvent('salt:navigate', {
                  detail: { id: pid, newTab: (e.metaKey || e.ctrlKey) && !e.altKey },
                }),
              );
            }}
          >
            @{title}
          </button>
        ) : (
          <span key={key++} className="page-link ai-mention-mark">
            @{title}
          </span>
        ),
      );
      idx = at + 1 + title.length;
    } else {
      out.push('@');
      idx = at + 1;
    }
  }
  return <Fragment>{out}</Fragment>;
}
