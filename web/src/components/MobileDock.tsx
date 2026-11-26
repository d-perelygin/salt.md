import { LayoutGrid, Menu, Plus, Search, Sparkles } from 'lucide-react';
import { t } from '../i18n';

/** The phone's permanent navigation.
 *
 *  Below 769px the desktop chrome stops earning its space: the tab strip takes
 *  a whole row under the topbar, search hides behind ⌘K nobody has on glass,
 *  and the actions sit in the two corners a thumb reaches last. What one
 *  actually does while reading on a phone — go somewhere else, switch document,
 *  search, ask the AI — moves here, along the bottom edge where the thumb
 *  already rests.
 *
 *  There is no "new page" slot: writing a page starts in the sidebar, where the
 *  tree and its + already live, and the drawer is the first button instead. A
 *  dock that creates and a tree that also creates is two front doors.
 *
 *  It is rendered on desktop as well and hidden by the stylesheet, so the
 *  markup, the accessible names and the tab order are the same in both worlds;
 *  only CSS decides which one the reader is in. */
export default function MobileDock({
  aiEnabled,
  chats,
  tabCount,
  onOpenSidebar,
  onOpenTabs,
  onSearch,
  onNewChat,
  onAi,
}: {
  aiEnabled: boolean;
  /** The AI chats view is open: the dock's middle slot becomes "new chat",
   *  because search is not what one wants from inside a conversation. */
  chats: boolean;
  /** How many documents are open — the tabs slot answers "how many" without
   *  being opened, which the desktop strip did at a glance. */
  tabCount: number;
  onOpenSidebar: () => void;
  onOpenTabs: () => void;
  onSearch: () => void;
  onNewChat?: () => void;
  onAi: () => void;
}) {
  return (
    <nav className="mobile-dock" aria-label={t('Main navigation')}>
      <button
        type="button"
        className="dock-btn"
        onClick={onOpenSidebar}
        aria-label={t('Menu')}
        title={t('Menu')}
      >
        <span className="dock-icon">
          <Menu size={19} />
        </span>
        <span className="dock-label">{t('Menu')}</span>
      </button>
      <button
        type="button"
        className="dock-btn"
        onClick={onOpenTabs}
        aria-label={t('Tabs')}
        title={t('Tabs')}
      >
        <span className="dock-icon">
          <LayoutGrid size={19} />
          {tabCount > 0 && (
            <span className="dock-badge" aria-hidden="true">
              {tabCount}
            </span>
          )}
        </span>
        <span className="dock-label">{t('Tabs')}</span>
      </button>
      {chats ? (
        <button
          type="button"
          className="dock-btn"
          onClick={() => onNewChat?.()}
          aria-label={t('New chat')}
          title={t('New chat')}
        >
          <span className="dock-icon">
            <Plus size={19} />
          </span>
          <span className="dock-label">{t('New chat')}</span>
        </button>
      ) : (
        <button
          type="button"
          className="dock-btn"
          onClick={onSearch}
          aria-label={t('Search')}
          title={t('Search')}
        >
          <span className="dock-icon">
            <Search size={19} />
          </span>
          <span className="dock-label">{t('Search')}</span>
        </button>
      )}
      {aiEnabled && (
        <button
          type="button"
          className="dock-btn"
          onClick={onAi}
          aria-label={t('AI')}
          title={t('AI')}
        >
          <span className="dock-icon">
            <Sparkles size={19} />
          </span>
          <span className="dock-label">{t('AI')}</span>
        </button>
      )}
    </nav>
  );
}
