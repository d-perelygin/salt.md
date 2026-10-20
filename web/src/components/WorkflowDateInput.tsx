import { useState } from 'react';
import { t } from '../i18n';
import { resolveSmartDate } from '../smartdate';
import { formatDay } from '../format';

// A date value the way collection filters enter one (see DateFilterValue in
// CollectionView): an Exact calendar day, or a Relative word the server
// resolves at read time ("today", "today+7d"). The workflow writes set_prop
// values verbatim, so a word stays live exactly like a filter value does —
// while a stamp rule resolves its word once, when it fires (see workflow.go).
export default function WorkflowDateInput({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: string) => void;
}) {
  const str = typeof value === 'string' ? value : '';
  // Exact or relative is a sticky choice, not derived from the value.
  const [relative, setRelative] = useState(
    () => str !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(str),
  );
  // Labels are built during render, never as a module constant.
  const presets: { token: string; label: string }[] = [
    { token: 'today', label: t('Today') },
    { token: 'yesterday', label: t('Yesterday') },
    { token: 'tomorrow', label: t('Tomorrow') },
    { token: 'today-7d', label: t('7 days ago') },
    { token: 'today-30d', label: t('30 days ago') },
    { token: 'today-1M', label: t('A month ago') },
    { token: 'today-3M', label: t('3 months ago') },
    { token: 'today-1Y', label: t('A year ago') },
    { token: 'today+7d', label: t('In 7 days') },
    { token: 'today+1M', label: t('In a month') },
  ];
  const exact = !relative;
  const resolved = resolveSmartDate(str);
  const picked = presets.some((p) => p.token === str) ? str : 'custom';
  return (
    <div className="fs-date">
      <div className="fs-seg">
        <button
          type="button"
          className={exact ? 'on' : ''}
          onClick={() => {
            // Baking the word in: switching to Exact keeps the day the word
            // names today, or clears an already-empty field.
            if (relative) {
              setRelative(false);
              onChange(resolved ?? '');
            }
          }}
        >
          {t('Exact')}
        </button>
        <button
          type="button"
          className={exact ? '' : 'on'}
          onClick={() => {
            if (exact) {
              setRelative(true);
              onChange('today');
            }
          }}
        >
          {t('Relative')}
        </button>
      </div>
      {exact ? (
        <input
          className="prop-input"
          type="date"
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <>
          <select
            className="prop-select"
            value={picked}
            onChange={(e) =>
              onChange(e.target.value === 'custom' ? (picked === 'custom' ? str : 'today') : e.target.value)
            }
          >
            {presets.map((p) => (
              <option key={p.token} value={p.token}>
                {p.label}
              </option>
            ))}
            <option value="custom">{t('Custom…')}</option>
          </select>
          <input
            className="prop-input"
            type="text"
            value={str}
            placeholder="today-1M" // i18n-ok: example token, identical in every language
            onChange={(e) => onChange(e.target.value)}
          />
          {str !== '' &&
            (resolved ? (
              <div className="fs-hint">{t('Resolves to {date}', { date: formatDay(resolved) })}</div>
            ) : (
              <div className="fs-hint">{t('Unknown relative day — try today-1M.')}</div>
            ))}
        </>
      )}
    </div>
  );
}
