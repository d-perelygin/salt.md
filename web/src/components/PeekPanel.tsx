import { useEffect, useRef } from 'react';
import { ChevronsRight, SquareArrowOutUpRight } from 'lucide-react';
import Editor, { type EditorProps } from './Editor';
import { t } from '../i18n';

// A side peek at a page: the document opens in a panel over the right side
// instead of taking over the tab you are in (Notion's side peek). Shift-click
// anywhere a page link opens one — rows, relation chips, the tree, search —
// and App answers the `salt:peek` event it dispatches (see pageOpen).
//
// The panel reuses the full Editor, so everything a page can do works here:
// editing, comments, shares, history. It mounts under its own keyboard region
// ('peek', see EditorProps.regionId), or its arrows would fight the main
// view's for the one shared 'content' region.

type Props = Omit<EditorProps, 'regionId' | 'primary'> & {
  onClose: () => void;
  onOpenFull: (id: string) => void;
};

export default function PeekPanel({ pageId, onClose, onOpenFull, ...editorProps }: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An open dropdown inside the peek owns Escape while it is up (it
      // closes itself) — closing the panel under it would strand the click
      // that opened it and surprise nobody in a good way.
      const t = e.target as Element | null;
      if (t?.closest?.('.peek-panel .menu')) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside className="peek-panel" aria-label={t('Preview')}>
      <div className="peek-bar">
        <button className="icon-btn" title={t('Close preview')} onClick={onClose}>
          <ChevronsRight size={17} />
        </button>
        <span className="peek-spacer" />
        <button
          className="icon-btn"
          title={t('Open as page ↗')}
          onClick={() => onOpenFull(pageId)}
        >
          <SquareArrowOutUpRight size={16} />
        </button>
      </div>
      <Editor key={pageId} {...editorProps} pageId={pageId} regionId="peek" primary={false} />
    </aside>
  );
}
