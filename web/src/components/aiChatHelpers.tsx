import { Fragment } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { toast } from '../toast';
import type { CollectionConfig, PageMeta } from '../types';

export interface CollectionTemplatePreset {
  id: 'sales' | 'content' | 'requests';
  badge: string;
  tone: 'green' | 'blue' | 'purple';
  label: () => string;
  title: () => string;
  description: () => string;
  icon: string;
  config: () => Partial<CollectionConfig>;
}

export const COLLECTION_PRESETS: CollectionTemplatePreset[] = [
  {
    id: 'sales',
    badge: '🤝',
    tone: 'green',
    label: () => t('Sales pipeline'),
    title: () => t('Deals'),
    description: () => t('One row per opportunity. Drag the board, do not edit a status field.'),
    icon: '💶',
    config: () => ({
      schema: [
        {
          id: 'stage',
          name: t('Stage'),
          type: 'select',
          options: [
            { id: 'qualifying', name: t('Qualifying'), color: '#787774' },
            { id: 'proposal', name: t('Proposal out'), color: '#337ea9' },
            { id: 'negotiation', name: t('Negotiation'), color: '#cb912f' },
            { id: 'won', name: t('Won'), color: '#448361' },
            { id: 'lost', name: t('Lost'), color: '#d44c47' },
          ],
        },
        { id: 'value', name: t('Value'), type: 'number' },
        { id: 'close', name: t('Expected close'), type: 'date' },
        { id: 'owner', name: t('Owner'), type: 'person' },
        {
          id: 'source',
          name: t('Came from'),
          type: 'select',
          options: [
            { id: 'referral', name: t('Referral'), color: '#448361' },
            { id: 'inbound', name: t('Inbound'), color: '#337ea9' },
            { id: 'outbound', name: t('Outbound'), color: '#cb912f' },
            { id: 'event', name: t('Event'), color: '#9065b0' },
          ],
        },
      ],
      views: [
        { id: 'board', name: t('Board'), type: 'board', groupBy: 'stage', filters: [], sort: null },
        { id: 'table', name: t('Table'), type: 'table', filters: [], sort: null },
        { id: 'closing', name: t('Closing'), type: 'calendar', dateProp: 'close', filters: [], sort: null },
      ],
    }),
  },
  {
    id: 'content',
    badge: '🗓️',
    tone: 'blue',
    label: () => t('Content calendar'),
    title: () => t('Content calendar'),
    description: () => t('One row per thing you publish. The draft lives in the page.'),
    icon: '🗓️',
    config: () => ({
      schema: [
        {
          id: 'status',
          name: t('Status'),
          type: 'select',
          options: [
            { id: 'idea', name: t('Idea'), color: '#787774' },
            { id: 'drafting', name: t('Drafting'), color: '#cb912f' },
            { id: 'review', name: t('In review'), color: '#337ea9' },
            { id: 'scheduled', name: t('Scheduled'), color: '#9065b0' },
            { id: 'published', name: t('Published'), color: '#448361' },
            { id: 'dropped', name: t('Dropped'), color: '#9f6b53' },
          ],
        },
        {
          id: 'channel',
          name: t('Channel'),
          type: 'select',
          options: [
            { id: 'blog', name: t('Blog'), color: '#337ea9' },
            { id: 'newsletter', name: t('Newsletter'), color: '#cb912f' },
            { id: 'social', name: t('Social'), color: '#9065b0' },
            { id: 'video', name: t('Video'), color: '#d44c47' },
            { id: 'podcast', name: t('Podcast'), color: '#448361' },
          ],
        },
        { id: 'publish', name: t('Goes out'), type: 'date' },
        { id: 'owner', name: t('Owner'), type: 'person' },
        { id: 'topic', name: t('Topic'), type: 'text' },
        { id: 'url', name: t('Published at'), type: 'url' },
      ],
      views: [
        { id: 'calendar', name: t('Calendar'), type: 'calendar', dateProp: 'publish', filters: [], sort: null },
        { id: 'board', name: t('Board'), type: 'board', groupBy: 'status', filters: [], sort: null },
        { id: 'table', name: t('Table'), type: 'table', filters: [], sort: null },
      ],
    }),
  },
  {
    id: 'requests',
    badge: '📥',
    tone: 'purple',
    label: () => t('Request tracker'),
    title: () => t('Requests'),
    description: () =>
      t('One row per request. Done needs a finished checklist — the board refuses the move otherwise.'),
    icon: '📥',
    config: () => ({
      schema: [
        {
          id: 'status',
          name: t('Status'),
          type: 'select',
          options: [
            { id: 'new', name: t('New'), color: '#787774' },
            { id: 'triage', name: t('Triage'), color: '#337ea9' },
            { id: 'in_progress', name: t('In progress'), color: '#cb912f' },
            { id: 'done', name: t('Done'), color: '#448361' },
          ],
        },
        { id: 'owner', name: t('Owner'), type: 'person' },
        { id: 'acceptance', name: t('Acceptance'), type: 'checklist' },
        { id: 'closed', name: t('Closed on'), type: 'date' },
      ],
      views: [
        { id: 'board', name: t('Board'), type: 'board', groupBy: 'status', filters: [], sort: null },
        { id: 'table', name: t('Table'), type: 'table', filters: [], sort: null },
      ],
      workflow: {
        statusPropId: 'status',
        rules: [
          {
            id: 'r0',
            when: { type: 'created' },
            do: [{ type: 'assign_me', prop: 'owner' }],
          },
          {
            id: 'r_triage',
            when: { type: 'status_to', to: 'triage' },
            do: [{ type: 'assign_me', prop: 'owner' }],
          },
          {
            id: 'r_done',
            when: { type: 'status_to', to: 'done' },
            allowFrom: ['in_progress'],
            precondition: { checklistProp: 'acceptance' },
            do: [{ type: 'set_today', prop: 'closed' }],
          },
        ],
      },
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
      await api.updatePage(targetId, {
        title: preset.title(),
        icon: preset.icon,
        description: preset.description(),
      });
      await api.putCollection(targetId, preset.config());
      window.dispatchEvent(new CustomEvent('salt:rows', { detail: targetId }));
      window.dispatchEvent(new CustomEvent('salt:page-reload', { detail: targetId }));
    } else {
      const created = await api.createPage(null, preset.title(), 'collection');
      targetId = created.id;
      await api.updatePage(targetId, {
        icon: preset.icon,
        description: preset.description(),
      });
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
