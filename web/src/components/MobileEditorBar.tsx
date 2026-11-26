import { useEffect, useState } from 'react';
import { Bold, Code, Italic, Sparkles, Strikethrough, Underline, Keyboard } from 'lucide-react';
import type { BlockNoteEditor } from '@blocknote/core';
import { t } from '../i18n';

// The phone's keyboard bar.
//
// A desktop has a formatting toolbar that appears over the selection, and a
// keyboard with every shortcut on it. A phone has neither: the selection
// toolbar is a fingertip away from the keys, and the shortcuts do not exist.
// So the actions one needs WHILE typing ride on top of the keyboard itself —
// the place a thumb already is, and the only strip of screen the keyboard
// leaves free.
//
// It shows itself only while the editor has focus (`isFocused`), which on a
// phone means the keyboard is up. Every button cancels pointerdown so the
// caret and the selection survive the tap: without that, pressing Bold would
// blur the editor and un-bold nothing.
export default function MobileEditorBar({
  editor,
  aiEnabled,
  onAskAi,
}: {
  editor: BlockNoteEditor<any, any, any>;
  aiEnabled: boolean;
  onAskAi: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [styles, setStyles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const syncVisibility = () => setVisible(editor.isFocused());
    // focusout fires before focus lands on the next element, so the check is
    // deferred by a task: tapping Bold must not flicker the bar away.
    const onFocusOut = () => setTimeout(syncVisibility, 0);
    document.addEventListener('focusin', syncVisibility);
    document.addEventListener('focusout', onFocusOut);
    syncVisibility();
    return () => {
      document.removeEventListener('focusin', syncVisibility);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [editor]);

  useEffect(() => {
    const read = () => setStyles({ ...(editor.getActiveStyles() as Record<string, boolean>) });
    read();
    return editor.onSelectionChange(read);
  }, [editor]);

  // The stylesheet gives the scroller room for the bar while it is up, so the
  // line being typed stays above it instead of under the thumb.
  useEffect(() => {
    document.body.classList.toggle('mobile-editing', visible);
    return () => document.body.classList.remove('mobile-editing');
  }, [visible]);

  const toggle = (style: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => {
    editor.toggleStyles({ [style]: true });
    setStyles({ ...(editor.getActiveStyles() as Record<string, boolean>) });
  };

  const keep = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="editor-keys" hidden={!visible} role="toolbar" aria-label={t('Formatting')}>
      {aiEnabled && (
        <button
          type="button"
          className="editor-key editor-key-ai"
          onPointerDown={keep}
          onClick={onAskAi}
          title={t('Ask AI')}
          aria-label={t('Ask AI')}
        >
          <Sparkles size={17} />
        </button>
      )}
      <button
        type="button"
        className={'editor-key' + (styles.bold ? ' is-on' : '')}
        onPointerDown={keep}
        onClick={() => toggle('bold')}
        title={t('Bold')}
        aria-label={t('Bold')}
        aria-pressed={!!styles.bold}
      >
        <Bold size={17} />
      </button>
      <button
        type="button"
        className={'editor-key' + (styles.italic ? ' is-on' : '')}
        onPointerDown={keep}
        onClick={() => toggle('italic')}
        title={t('Italic')}
        aria-label={t('Italic')}
        aria-pressed={!!styles.italic}
      >
        <Italic size={17} />
      </button>
      <button
        type="button"
        className={'editor-key' + (styles.underline ? ' is-on' : '')}
        onPointerDown={keep}
        onClick={() => toggle('underline')}
        title={t('Underline')}
        aria-label={t('Underline')}
        aria-pressed={!!styles.underline}
      >
        <Underline size={17} />
      </button>
      <button
        type="button"
        className={'editor-key' + (styles.strike ? ' is-on' : '')}
        onPointerDown={keep}
        onClick={() => toggle('strike')}
        title={t('Strikethrough')}
        aria-label={t('Strikethrough')}
        aria-pressed={!!styles.strike}
      >
        <Strikethrough size={17} />
      </button>
      <button
        type="button"
        className={'editor-key' + (styles.code ? ' is-on' : '')}
        onPointerDown={keep}
        onClick={() => toggle('code')}
        title={t('Code')}
        aria-label={t('Code')}
        aria-pressed={!!styles.code}
      >
        <Code size={17} />
      </button>
      {/* The keyboard's own dismissal, in the app: an installed PWA has no
          "Done" on the keyboard on every platform, and one is needed. */}
      <button
        type="button"
        className="editor-key editor-key-hide"
        onPointerDown={keep}
        onClick={() => (document.activeElement as HTMLElement | null)?.blur()}
        title={t('Hide keyboard')}
        aria-label={t('Hide keyboard')}
      >
        <Keyboard size={17} />
      </button>
    </div>
  );
}
