import { compare, isReadableDay, isUnfinishedRelativeDay, resolveSmartDate } from './format';
import { SORT_CREATED, SORT_UPDATED, TEMPLATE_FILTER, TITLE_FILTER } from './types';
import type { Filter, FilterOp, User } from './types';

function isEmptyVal(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  return v === undefined || v === '' || v === null || v === false;
}

/** What a condition compares against: the set if there is one, else the single
 *  value. Never both — the same rule the server applies (rowFilter.vals). */
export function filterValues(f: Filter): string[] {
  if (f.values?.length) return f.values;
  return f.value ? [f.value] : [];
}

/** Is this condition finished enough to mean anything? An unfinished one must
 *  not filter: comparing against the empty string emptied the table the moment
 *  somebody added "Date is …", before they had typed a thing, which is what
 *  made the date filter look broken. `is_empty` is the deliberate version.
 *  A half-typed relative day ("today-") waits the same way, and on a date
 *  property so does anything that is not a day yet (see liveValue). */
export function filterIsArmed(f: Filter, isDate = false): boolean {
  const op = f.op ?? (f.value ? 'is' : 'is_not_empty');
  if (op === 'is_empty' || op === 'is_not_empty') return true;
  const live = (v: string) => liveValue(v, op, isDate);
  if (op === 'between') return !!f.value && (f.value2 ?? '') !== '' && live(f.value ?? '') && live(f.value2 ?? '');
  const vals = filterValues(f);
  return vals.length > 0 && vals.some(live);
}

/** May this value take part in the comparison? On a date property only a day
 *  or a relative day that resolves can (isReadableDay), except under
 *  "contains", which looks for text. Elsewhere only the dangling sign of a
 *  half-typed relative day waits. The server drops the same values. */
function liveValue(v: string, op: FilterOp, isDate: boolean): boolean {
  return isDate && op !== 'contains' ? isReadableDay(v) : !isUnfinishedRelativeDay(v);
}

/** A list cell as the texts a filter compares: plain-string arrays (a select
 *  with several values, a relation, a person) come back unchanged, while a
 *  checklist holds objects and compares by each item's text — legacy
 *  plain-string items count as their own text. The same rule the server
 *  applies (see rowFilter), so the two never disagree about a row. */
function cellTexts(v: unknown[]): string[] {
  return v.map((x) => (typeof x === 'string' ? x : typeof (x as { text?: unknown })?.text === 'string' ? (x as { text: string }).text : ''));
}

export function matchesFilter(
  row: {
    props: Record<string, unknown>;
    title?: string;
    isTemplate?: boolean;
    createdAt?: string;
    updatedAt?: string;
  },
  f: Filter,
  isDate: boolean,
  isNumber = false,
  isPerson = false,
  currentUser: User | null = null,
): boolean {
  // The one condition that is not about a column (see TEMPLATE_FILTER). The
  // server filters on it too; this is the same answer for the rows it sent.
  if (f.property === TEMPLATE_FILTER) {
    if (!filterIsArmed(f)) return true;
    return String(!!row.isTemplate) === f.value;
  }
  // The row's own title, filterable like a column. Words or a regular
  // expression — the two questions a long table answers badly by eye. An
  // invalid pattern filters nothing rather than blanking the table while it is
  // still being typed.
  if (f.property === TITLE_FILTER) {
    if (!filterIsArmed(f)) return true;
    const title = row.title ?? '';
    const need = f.value ?? '';
    // The reader's choice, and the same one the server applies: folding case
    // here is Unicode-aware, but only when it was asked for.
    const fold = (s: string) => (f.caseSensitive ? s : s.toLowerCase());
    switch (f.op ?? (need ? 'is' : 'is_not_empty')) {
      case 'is_empty':
        return title.trim() === '';
      case 'is_not_empty':
        return title.trim() !== '';
      case 'contains':
        return fold(title).includes(fold(need));
      case 'not_contains':
        return !fold(title).includes(fold(need));
      case 'matches':
        try {
          return new RegExp(need, f.caseSensitive ? '' : 'i').test(title);
        } catch {
          return true;
        }
      case 'is_not':
        return fold(title) !== fold(need);
      default:
        return fold(title) === fold(need);
    }
  }
  // Created and Updated read the row's own timestamps as days — the same days
  // the server compares — and then answer through the shared operators below.
  const v =
    f.property === SORT_CREATED
      ? (row.createdAt ?? '').slice(0, 10)
      : f.property === SORT_UPDATED
        ? (row.updatedAt ?? '').slice(0, 10)
        : row.props[f.property];
  const op = f.op ?? (f.value ? 'is' : 'is_not_empty');
  if (!filterIsArmed(f, isDate)) return true;
  // A relative day names a different date every day. Resolve it now — the
  // same way the server resolves it per query — or the rows the server sent
  // and the rows shown here would disagree. Date properties only: a status
  // option named "Today" must keep matching the option, not the date.
  const day = (s: string) => (isDate ? (resolveSmartDate(s) ?? s) : s);
  const live = (s: string) => liveValue(s, op, isDate);
  const value = day(f.value ?? '');
  const rawVals = filterValues(f).filter(live);
  const vals: string[] = [];
  for (const item of rawVals) {
    // "@me" on a person is whoever is looking: their id, and their name too,
    // because a person an agent wrote as plain text is matched by name, as its
    // chip is. The server resolves it the same way per query (resolvePerson).
    if (isPerson && item === '@me') {
      if (currentUser?.id) vals.push(currentUser.id);
      if (currentUser?.name && currentUser.name !== currentUser.id) vals.push(currentUser.name);
      if (!currentUser?.id) vals.push('__nobody__');
    } else {
      vals.push(day(item));
    }
  }
  // One value or several, the question is the same: does the cell hold any of
  // them. A cell may itself be a list (multiselect, relation, person).
  const holdsAny = () =>
    Array.isArray(v)
      ? vals.some((x) => cellTexts(v).includes(x))
      : vals.some((x) =>
          isNumber && v !== undefined && v !== null && v !== ''
            ? Number(v) === Number(x)
            : x === 'true' || x === 'false' ? String(v === true) === x : String(v ?? '') === x,
        );
  switch (op) {
    case 'is_empty':
      return isEmptyVal(v);
    case 'is_not_empty':
      return !isEmptyVal(v);
    case 'contains': {
      // Text, even "@me": the marker belongs to is and is not, where the
      // picker offers it. The server reads it the same way.
      const needle = value.toLowerCase();
      if (Array.isArray(v)) return cellTexts(v).some((x) => x.toLowerCase().includes(needle));
      return String(v ?? '').toLowerCase().includes(needle);
    }
    case 'gt':
    case 'lt': {
      const nv = Number(v);
      const nf = Number(value);
      const cmp = !Number.isNaN(nv) && !Number.isNaN(nf) ? nv - nf : compare(String(v ?? ''), value);
      return op === 'gt' ? cmp > 0 : cmp < 0;
    }
    case 'between': {
      // Inclusive at both ends — a range named by two dates contains them.
      // ISO dates compare correctly as text, so only numbers need Number().
      const hi = f.value2 === undefined ? '' : isDate ? (resolveSmartDate(f.value2) ?? f.value2) : f.value2;
      const nv = Number(v);
      if (!Number.isNaN(nv) && !Number.isNaN(Number(value)) && !Number.isNaN(Number(hi))) {
        return nv >= Number(value) && nv <= Number(hi);
      }
      const sv = String(v ?? '');
      return sv !== '' && sv >= value && sv <= hi;
    }
    case 'is_not':
      return !holdsAny();
    case 'is':
    default:
      // Checkbox filters compare against a boolean; a never-toggled box has no
      // stored value, which must count as "false" (unchecked), not "no match".
      return holdsAny();
  }
}
