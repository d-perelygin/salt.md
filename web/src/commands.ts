import { runCommand, shortcutList } from './keys';

// The command palette inside the search box.
//
// The source of truth stays the shortcut registry (keys.ts): a row appears
// here only while it is really bound, the label is the same function the help
// sheet reads, and Enter runs the same run() a keypress would. This file adds
// two things the registry does not have: WHICH ids are palette-worthy, and
// the trilingual aliases that make them searchable in every language.
//
// The aliases follow the slash menu's mechanism (see slashAliases in
// Editor.tsx): the menu matches the query against the title and the aliases,
// so each entry carries its English, German and Russian names on top of
// whatever the active dictionary gave it.

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keys: string;
}

// Global actions, not region navigation or modal plumbing: nav.* needs a
// focused region to mean anything, and Close is pointless inside a palette.
const PALETTE_IDS = new Set([
  'page.new',
  'collection.new',
  'library.open',
  'notes.toggle',
  'page.favorite',
  'tabs.next',
  'tabs.prev',
  'template.new',
  'page.trash',
  'comments.toggle',
  'checkbox.toggle',
  'block.moveUp',
  'block.moveDown',
  'help.shortcuts',
]);

const COMMAND_ALIASES: Record<string, string[]> = {
  'page.new': ['new note', 'neue notiz', 'notiz', 'новая заметка', 'заметка', 'создать страницу'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'collection.new': ['new collection', 'neue datenbank', 'sammlung', 'новая коллекция', 'коллекция', 'база данных'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'library.open': ['library', 'bibliothek', 'библиотека'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'notes.toggle': ['notes mode', 'notizen', 'режим заметок', 'заметки'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'page.favorite': ['favorite', 'favorit', 'избранное', 'в избранное'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'tabs.next': ['next tab', 'nächster tab', 'следующая вкладка'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'tabs.prev': ['previous tab', 'vorheriger tab', 'предыдущая вкладка'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'template.new': ['template', 'vorlage', 'шаблон', 'из шаблона'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'page.trash': ['trash', 'papierkorb', 'корзина', 'удалить', 'в корзину'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'comments.toggle': ['comments', 'kommentare', 'комментарии'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'checkbox.toggle': ['checkbox', 'ankreuzen', 'kontrollkästchen', 'чекбокс', 'галочка', 'отметить'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'block.moveUp': ['move block up', 'block nach oben', 'блок вверх', 'переместить блок'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'block.moveDown': ['move block down', 'block nach unten', 'блок вниз', 'переместить блок'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
  'help.shortcuts': ['shortcuts', 'tastaturkürzel', 'горячие клавиши', 'шорткаты'], // i18n-ok: search aliases, deliberately trilingual (en/de/ru)
};

/** Commands bound right now, in palette order. Recomputed per render so a
 *  language switch and a `when` change both reach the list. */
export function paletteCommands(): (PaletteCommand & { aliases: string[] })[] {
  return shortcutList()
    .filter((c) => PALETTE_IDS.has(c.id))
    .map((c) => ({ ...c, aliases: COMMAND_ALIASES[c.id] ?? [] }));
}

/** Substring match against the live label, the id and every alias — in
 *  whatever language the fingers type. */
export function matchCommands(
  q: string,
  cmds: (PaletteCommand & { aliases: string[] })[],
): (PaletteCommand & { aliases: string[] })[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return cmds;
  return cmds.filter(
    (c) =>
      c.label.toLowerCase().includes(needle) ||
      c.id.toLowerCase().includes(needle) ||
      c.aliases.some((a) => a.toLowerCase().includes(needle)),
  );
}

/** Run a palette row the way its chord would. Returns what the run returned —
 *  `false` means the shortcut decided not to act after all. */
export function runPaletteCommand(id: string): boolean | void {
  return runCommand(id, new KeyboardEvent('keydown', { key: 'Enter' }));
}
