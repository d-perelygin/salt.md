// Which of a person's two names a field prints.
//
// An account has a formal `name` — the one code, audit lines and the account
// list use — and an optional `nickname`, the one people actually recognise in
// a task's Owner column. The instance decides the default (display_name_mode,
// nickname by default); each account may override it for its own screen
// without changing anybody else's. The choice therefore lives here, resolved
// once, instead of in every component that draws a face.

import type { Prefs } from './i18n';
import { useEffect, useState } from 'react';

export type NameMode = 'name' | 'nickname';

let instanceDefault: NameMode = 'nickname';
let personalChoice: '' | NameMode = '';
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** The instance setting, from /api/me (the settings route is admin-only). */
export function setServerNameDisplay(mode: string | null | undefined): void {
  instanceDefault = mode === 'name' ? 'name' : 'nickname';
  notify();
}

/** This account's own choice, from the saved preferences. '' follows the
 *  instance. */
export function setPersonalNameDisplay(mode: Prefs['nameDisplay'] | string | null | undefined): void {
  personalChoice = mode === 'name' || mode === 'nickname' ? mode : '';
  notify();
}

/** Re-render a component when the choice changes, so saving it in the profile
   shows up on the person chips already on screen. */
export function useNameDisplay(): NameMode {
  const [mode, setMode] = useState<NameMode>(nameMode);
  useEffect(() => {
    const fn = () => setMode(nameMode());
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return mode;
}

export function nameMode(): NameMode {
  return personalChoice || instanceDefault;
}

/** What a person field should print. A missing nickname falls back to the
 *  formal name, and a value written by hand (no account behind it) prints as
 *  itself. */
export function displayName(person: { name?: string; nickname?: string } | null | undefined): string {
  if (!person) return '';
  const name = (person.name ?? '').trim();
  const nickname = (person.nickname ?? '').trim();
  if (nameMode() === 'nickname' && nickname) return nickname;
  return name || nickname;
}
