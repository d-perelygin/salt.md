import { useEffect, useState } from 'react';
import { X, Mail, Building2, Pencil, FileText, Table2, UserRound } from 'lucide-react';
import { api } from '../api';
import type { PersonProfile } from '../types';
import { useExclusiveModal } from '../modal';
import { formatRelative } from '../format';
import { nameColor } from './CommentsPanel';
import { PageIcon } from '../pageIcon';
import { t } from '../i18n';
import Portal from './Portal';

// One account's page — the view behind a name.
//
// A person field answers "who is on this", not "who is this". Notion gives
// every account a page with a cover, their name, About, the workspaces they
// share with you, what they have been editing and the pages they own. This is
// the same page from data salt.md already keeps. The formal name and the
// nickname are both shown here: fields print one of them (see personName.ts);
// the page is where the two are told apart.

function roleWord(role: string | undefined): string {
  switch (role) {
    case 'owner':
      // Not t('Owner'): that source is the usual name of an Owner column and
      // reads "Ответственный" in Russian. This is the instance owner.
      return t('Instance owner');
    case 'admin':
      return t('Admin');
    case 'member':
      return t('Member');
    case 'viewer':
      return t('Viewer');
    default:
      return role || t('Member');
  }
}

export default function PersonPage({
  userId,
  onClose,
  onEditSelf,
}: {
  userId: string;
  onClose: () => void;
  /** Only for one's own page: opens the profile editor. */
  onEditSelf?: () => void;
}) {
  useExclusiveModal(onClose);
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .getPerson(userId)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!profile) return;
    document.title = `${profile.user.name} · salt.md`;
    return () => {
      document.title = 'salt.md';
    };
  }, [profile]);

  const open = (id: string) => {
    window.dispatchEvent(new CustomEvent('salt:navigate', { detail: { id } }));
    onClose();
  };

  const user = profile?.user;
  const nick = (user?.nickname ?? '').trim();

  return (
    <Portal>
      <div
        className="person-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="person-page" role="dialog" aria-modal="true" aria-label={user ? user.name : t('Account')}>
          <div className="person-actions">
            {profile?.isYou && onEditSelf && (
              <button className="btn person-edit" onClick={onEditSelf}>
                <Pencil size={14} /> {t('Edit profile')}
              </button>
            )}
            <button className="person-close icon-btn" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
              <X size={17} />
            </button>
          </div>

          {!profile ? (
            <div className="person-empty dialog-hint">
              {failed ? t('This account is not available.') : t('Loading…')}
            </div>
          ) : (
            <>
              <div
                className="person-cover"
                style={{
                  background: user!.color || nameColor(user!.name),
                }}
              >
                <span className="person-cover-fade" />
              </div>

              <div className="person-head">
                <span
                  className="person-avatar"
                  style={{ background: user!.avatar ? 'transparent' : user!.color || nameColor(user!.name) }}
                >
                  {user!.avatar ? (
                    <img src={user!.avatar} alt="" />
                  ) : (
                    (user!.name.trim().charAt(0).toUpperCase() || '?')
                  )}
                </span>
                <div className="person-head-text">
                  <h1 className="person-name">
                    {user!.name}
                    {profile.isYou && <span className="person-you"> ({t('You')})</span>}
                  </h1>
                  {nick && <div className="person-nick">@{nick}</div>}
                  {user!.about ? <p className="person-about-lead">{user!.about}</p> : null}
                </div>
              </div>

              <div className="person-body">
                <section className="person-main">
                  <h2 className="person-section-title">{t('Recent activity')}</h2>
                  {profile.recent.length > 0 ? (
                    <div className="person-activity">
                      {profile.recent.map((r) => (
                        <button key={r.id} className="person-activity-row" onClick={() => open(r.id)}>
                          <span className="person-activity-icon">
                            <PageIcon icon={r.icon} size={15} fallback={<FileText size={15} />} />
                          </span>
                          <span className="person-activity-text">
                            {t('Edited')} <span className="person-activity-title">{r.title || t('Untitled')}</span>
                          </span>
                          <span className="person-activity-time">{formatRelative(r.at)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="person-empty-line">{t('Nothing yet.')}</p>
                  )}

                  <h2 className="person-section-title">{t('Pages')}</h2>
                  {profile.pages.length > 0 ? (
                    <div className="person-pages">
                      {profile.pages.map((p) => (
                        <button key={p.id} className="person-page-card" onClick={() => open(p.id)}>
                          <span className="person-page-icon">
                            <PageIcon
                              icon={p.icon}
                              size={17}
                              fallback={p.type === 'collection' ? <Table2 size={17} /> : <FileText size={17} />}
                            />
                          </span>
                          <span className="person-page-title">{p.title || t('Untitled')}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="person-empty-line">{t('No pages yet.')}</p>
                  )}
                </section>

                <aside className="person-side">
                  <h2 className="person-side-title">{t('About')}</h2>
                  <p className={user!.about ? 'person-side-text' : 'person-side-empty'}>{user!.about || t('Empty')}</p>

                  <h2 className="person-side-title">
                    <Mail size={14} /> {t('Email')}
                  </h2>
                  <p className="person-side-text">
                    <a href={`mailto:${user!.email}`}>{user!.email}</a>
                  </p>

                  <h2 className="person-side-title">
                    <UserRound size={14} /> {t('Membership type')}
                  </h2>
                  <p>
                    <span className={'person-role' + (user!.orgRole === 'owner' ? ' is-owner' : '')}>
                      {roleWord(user!.orgRole)}
                    </span>
                  </p>

                  <h2 className="person-side-title">
                    <Building2 size={14} /> {t('Workspaces')}
                  </h2>
                  {profile.workspaces.length > 0 ? (
                    <ul className="person-workspaces">
                      {profile.workspaces.map((w) => (
                        <li key={w.id}>
                          <span className="person-ws-name">{w.name}</span>
                          <span className="person-ws-role">{roleWord(w.role)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="person-side-empty">{t('None')}</p>
                  )}
                </aside>
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
