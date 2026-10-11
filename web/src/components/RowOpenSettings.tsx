import { useState } from 'react';
import Portal from './Portal';
import { useExclusiveModal } from '../modal';
import { api } from '../api';
import { applyPrefs, getPrefs, t, type Prefs } from '../i18n';

// Whether collection rows open in a new tab (W127).
//
// A plain click on a row used to navigate the current tab in place, like the
// sidebar — so looking at a task lost the collection behind it. Now it opens
// beside it by default, and the modifier inverts (see pageOpen): with the
// setting on, ⌘/Ctrl-click stays in place; with it off, everything reads as
// before. The choice is an account preference, like the language — the phone
// and the laptop must not disagree about what a click does.
export function RowOpenModal({ onClose }: { onClose: () => void }) {
  useExclusiveModal(onClose);
  const [prefs, setPrefs] = useState<Prefs>(getPrefs());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Absent is the new default, a new tab — see server/prefs.go, which stores
  // NULL for "never decided" so older accounts need no backfill.
  const checked = prefs.openRowsNewTab ?? true;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const stored = await api.putPrefs({ ...prefs, openRowsNewTab: checked });
      await applyPrefs(stored);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Portal>
      <div
        className="modal-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="dialog" role="dialog" aria-modal="true" aria-label={t('Open rows in new tab')}>
          <h2>{t('Open rows in new tab')}</h2>
          <p className="dialog-hint">
            {t(
              'A click on a row in any collection view opens it in a new tab. Hold ⌘ or Ctrl to open in the current tab instead.',
            )}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setPrefs({ ...prefs, openRowsNewTab: e.target.checked })}
            />
            {t('Open collection rows in a new tab')}
          </label>
          {error && <div className="login-error">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('Saving…') : t('Save')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
