import { useEffect, useState } from 'react';
import { api } from '../api';
import Portal from './Portal';
import { useExclusiveModal } from '../modal';
import { toast } from '../toast';
import { t } from '../i18n';

type Access = 'view' | 'edit';
interface Share {
  userId: string;
  name: string;
  email: string;
  access: Access;
}
interface Member {
  userId: string;
  name: string;
  email: string;
}

// Who else may see a restricted page and its sub-pages. Only workspace admins
// and the page owner ever get the list — everybody else is turned away by the
// server, and the dialog says so instead of showing an empty list.
export default function PageShares({
  pageId,
  workspaceId,
  myUserId,
  onClose,
  onUnrestricted,
}: {
  pageId: string;
  workspaceId: string;
  myUserId: string;
  onClose: () => void;
  onUnrestricted: () => void;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [picked, setPicked] = useState('');
  const [pickedAccess, setPickedAccess] = useState<Access>('view');
  useExclusiveModal(onClose);

  const load = () =>
    void api
      .listPageShares(pageId)
      .then((l) => {
        setShares(l);
        setDenied(false);
      })
      .catch(() => {
        setShares([]);
        setDenied(true);
      });
  useEffect(load, [pageId]);
  useEffect(() => {
    void api.listMembers(workspaceId).then(setMembers).catch(() => {});
  }, [workspaceId]);

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    try {
      await api.grantPageShare(pageId, picked, pickedAccess);
      setPicked('');
      load();
    } catch (err) {
      toast((err as Error).message || t('Could not share the page'));
    }
  };

  const changeAccess = async (s: Share, access: Access) => {
    try {
      await api.grantPageShare(pageId, s.userId, access);
      load();
    } catch (err) {
      toast((err as Error).message || t('Could not change the access'));
    }
  };

  const revoke = async (s: Share) => {
    try {
      await api.revokePageShare(pageId, s.userId);
      load();
    } catch (err) {
      toast((err as Error).message || t('Could not remove the access'));
    }
  };

  const unrestrict = async () => {
    try {
      await api.updatePage(pageId, { visibility: 'workspace' });
      onUnrestricted();
      onClose();
    } catch {
      toast(t('Visibility not saved'));
    }
  };

  const granted = new Set((shares ?? []).map((s) => s.userId));
  const candidates = members.filter((m) => !granted.has(m.userId));

  return (
    <Portal>
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label={t('Sharing')}>
          <h2>{t('Sharing')}</h2>
          {denied ? (
            <p>{t('Only workspace admins and the page owner can manage access.')}</p>
          ) : (
            <>
              <p className="prop-empty">
                {t('Only the people below can see this page and its sub-pages. Workspace admins always can.')}
              </p>
              <div className="user-list">
                {(shares ?? []).map((s) => (
                  <div key={s.userId} className="user-row">
                    <span className="user-row-name">
                      {s.name} {s.userId === myUserId && <span className="prop-empty">{t('(you)')}</span>}
                    </span>
                    <span className="user-row-email">{s.email}</span>
                    <select
                      className="prop-select"
                      value={s.access}
                      onChange={(e) => void changeAccess(s, e.target.value as Access)}
                    >
                      <option value="view">{t('Can view')}</option>
                      <option value="edit">{t('Can edit')}</option>
                    </select>
                    <button className="btn-sm danger" onClick={() => void revoke(s)}>
                      {t('Remove')}
                    </button>
                  </div>
                ))}
                {shares?.length === 0 && (
                  <p className="prop-empty">{t('Nobody yet — the page is visible to nobody but you and the workspace admins.')}</p>
                )}
              </div>
              {candidates.length > 0 && (
                <form className="user-add" onSubmit={(e) => void grant(e)}>
                  <select
                    className="prop-select"
                    value={picked}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    <option value="">{t('Add a member…')}</option>
                    {candidates.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} ({m.email})
                      </option>
                    ))}
                  </select>
                  <select
                    className="prop-select"
                    value={pickedAccess}
                    onChange={(e) => setPickedAccess(e.target.value as Access)}
                  >
                    <option value="view">{t('Can view')}</option>
                    <option value="edit">{t('Can edit')}</option>
                  </select>
                  <button className="btn-sm" type="submit" disabled={!picked}>
                    {t('Share')}
                  </button>
                </form>
              )}
              <div className="share-actions">
                <button className="btn-sm" onClick={() => void unrestrict()}>
                  {t('Make visible to the workspace')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
