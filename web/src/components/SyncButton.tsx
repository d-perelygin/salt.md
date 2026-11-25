import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { checkForNewVersion, isDesktopApp, isDesktopPointer, isStandalone, requestRefresh } from '../pwa';
import {
  discardOp,
  flush,
  onOutboxChange,
  pendingCount,
  pendingDirtyDocs,
  pendingOps,
  type OutboxOp,
} from '../outbox';
import { plural, t } from '../i18n';

export default function SyncButton() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [ops, setOps] = useState<OutboxOp[]>([]);
  const [dirtyDocs, setDirtyDocs] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  const loadList = () => {
    void Promise.all([pendingOps(), pendingDirtyDocs()]).then(([list, docs]) => {
      setOps(list);
      setDirtyDocs(docs);
    });
  };

  useEffect(() => {
    const decide = () => setShow((isStandalone() || isDesktopApp()) && isDesktopPointer());
    decide();
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener('change', decide);
    return () => mq.removeEventListener('change', decide);
  }, []);

  useEffect(() => {
    let alive = true;
    void pendingCount().then((n) => alive && setPending(n));
    const stop = onOutboxChange((n) => {
      setPending(n);
      if (n === 0) setPanelOpen(false);
      if (n > 0) loadList();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  if (!show && pending === 0) return null;

  const syncNow = () => {
    setBusy(true);
    void flush().then(() => {
      requestRefresh();
      void checkForNewVersion();
      loadList();
    });
    window.setTimeout(() => setBusy(false), 650);
  };

  return (
    <div className="sync-wrap">
      <button
        className="icon-btn sync-btn"
        title={pending > 0 ? t('Sync now') : t('Fetch the latest changes')}
        aria-label={pending > 0 ? t('Sync now') : t('Fetch the latest changes')}
        disabled={busy}
        onClick={() => {
          if (pending > 0) {
            const next = !panelOpen;
            setPanelOpen(next);
            if (next) loadList();
          }
          syncNow();
        }}
      >
        <RefreshCw size={16} className={busy ? 'ptr-spin' : ''} />
        {pending > 0 ? <span className="sync-badge">{pending}</span> : null}
      </button>
      {panelOpen && pending > 0 ? (
        <div className="sync-panel" role="status">
          <div className="sync-panel-title">
            {plural(pending, '{n} change waiting to sync', '{n} changes waiting to sync')}
          </div>
          <ul style={{ maxHeight: 240, overflowY: 'auto' }}>
            {ops.map((op) => (
              <li key={op.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {op.label}
                  {op.attempts > 0 ? ` (${op.attempts})` : ''}
                  {op.lastError ? ` — ${op.lastError}` : ''}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title={t('Discard')}
                  aria-label={t('Discard')}
                  onClick={() => void discardOp(op.key).then(loadList)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            {dirtyDocs.map((id) => (
              <li key={`ydoc-${id}`}>{t('Page edits (pending live sync)')}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
