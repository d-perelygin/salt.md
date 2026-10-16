import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Editor, { type EditorProps } from './Editor';
import { t } from '../i18n';

// A side peek at a page: the document opens in a panel over the right side
// instead of taking over the tab you are in (Notion's side peek). Option-click
// anywhere a page link opens one — rows, relation chips, the tree, search —
// and App answers the `salt:peek` event it dispatches (see pageOpen).
//
// The panel reuses the full Editor, so everything a page can do works here:
// editing, comments, shares, history. The panel controls live inline at the
// head of its topbar (see onPeekClose in Editor) rather than on a bar of
// their own. It mounts under its own keyboard region ('peek', see
// EditorProps.regionId), or its arrows would fight the main view's for the
// one shared 'content' region.

type Props = Omit<EditorProps, 'regionId' | 'primary'> & {
  onClose: () => void;
  focusTitleOnMount?: boolean;
  onOpenFull: (id: string) => void;
  /** Pinned: nothing hides the panel but its own close button. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Step between table rows: previous/next in the order the peek opened with. */
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
};

export default function PeekPanel({
  pageId,
  onClose,
  onOpenFull,
  focusTitleOnMount,
  pinned,
  onTogglePin,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  ...editorProps
}: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An open dropdown inside the peek owns Escape while it is up (it
      // closes itself) — closing the panel under it would strand the click
      // that opened it and surprise nobody in a good way.
      const t = e.target as Element | null;
      if (t?.closest?.('.peek-panel .menu')) return;
      // A pinned panel is one you asked to keep: Escape is not its master.
      if (pinnedRef.current) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside className="peek-panel" aria-label={t('Preview')}>
      {(hasPrev || hasNext) && (
        <div className="peek-nav" aria-label={t('Row navigation')}>
          <button
            className="peek-nav-btn"
            onClick={onPrev}
            disabled={!hasPrev}
            title={t('Previous row')}
            aria-label={t('Previous row')}
          >
            <ChevronUp size={16} />
          </button>
          <button
            className="peek-nav-btn"
            onClick={onNext}
            disabled={!hasNext}
            title={t('Next row')}
            aria-label={t('Next row')}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      )}
      <Editor
        key={pageId}
        {...editorProps}
        pageId={pageId}
        focusTitleOnMount={focusTitleOnMount}
        regionId="peek"
        primary={false}
        onPeekClose={onClose}
        onPeekOpenFull={onOpenFull}
        onPeekPin={onTogglePin}
        peekPinned={pinned}
      />
    </aside>
  );
}
