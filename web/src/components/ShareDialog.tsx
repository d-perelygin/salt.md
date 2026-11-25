import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n';

export type ShareTab = 'share' | 'publish';

// One dialog for both halves of sharing: who is in (the workspace access
// list) and what is out (the public read-only link). The topbar keeps two
// entry buttons — the lock opens the Share tab, the globe the Publish tab —
// but there is a single menu, Notion-style, with the tabs across the top.
export default function ShareDialog({
  tab,
  onTabChange,
  share,
  publish,
}: {
  tab: ShareTab;
  onTabChange: (tab: ShareTab) => void;
  share: ReactNode;
  publish: ReactNode;
}) {
  const tabs: { id: ShareTab; label: string }[] = [
    { id: 'share', label: t('Share') },
    { id: 'publish', label: t('Publish') },
  ];
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(tabs.findIndex((x) => x.id === tab) + dir + tabs.length) % tabs.length];
    onTabChange(next.id);
    // Focus follows the selected tab, like a native tablist.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
    });
  };
  return (
    <div className="menu share-dialog" role="dialog" aria-label={t('Share')}>
      <div ref={listRef} className="share-tabs" role="tablist" aria-label={t('Share')} onKeyDown={onKeyDown}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            data-tab={x.id}
            aria-selected={tab === x.id}
            tabIndex={tab === x.id ? 0 : -1}
            className={'share-tab' + (tab === x.id ? ' is-on' : '')}
            onClick={() => onTabChange(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="share-tab-panel" role="tabpanel">
        {tab === 'share' ? share : publish}
      </div>
    </div>
  );
}
