import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec } from '@blocknote/react';
import { bookmarkSpec, databaseSpec, calloutSpec, tocSpec, subpagesSpec, columnsSpec, mermaidSpec } from './blocks';

// A "pageLink" is an inline mention of another salt.md page. It stores the target
// page id and a display label. Clicking it dispatches a navigation event that
// App listens for (keeps BlockNote's render decoupled from React routing).
// The modifiers travel in the event: Option peeks, ⌘/Ctrl-click opens beside
// the current tab, Ctrl/⌘ together with Alt stays — the same rule as every
// other page link (see pageOpen).
import { peekPage } from './pageOpen';

export const pageLinkSpec = createReactInlineContentSpec(
  {
    type: 'pageLink',
    propSchema: {
      pageId: { default: '' },
      label: { default: '' },
    },
    content: 'none',
  } as const,
  {
    render: (props) => {
      const pid = props.inlineContent.props.pageId;
      return (
        <button
          type="button"
          className="page-link"
          contentEditable={false}
          onClick={(e) => {
            if (peekPage(e, pid)) return;
            window.dispatchEvent(
              new CustomEvent('salt:navigate', {
                detail: { id: pid, newTab: (e.metaKey || e.ctrlKey) && !e.altKey },
              }),
            );
          }}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            if (peekPage(e, pid)) return;
            window.dispatchEvent(
              new CustomEvent('salt:navigate', {
                detail: { id: pid, newTab: !(e.altKey && (e.metaKey || e.ctrlKey)) },
              }),
            );
          }}
        >
          <span className="page-link-icon">🔗</span>
          {props.inlineContent.props.label || 'Untitled'}
        </button>
      );
    },
  },
);

// Schema = the default blocks plus our own (callout, table of contents,
// sub-pages, bookmark/embed, embedded database, columns) and the pageLink inline content.
// createReactBlockSpec returns a factory in 0.51 — call it.
//
// Columns used to come from @blocknote/xl-multi-column, which is BlockNote's
// PAID tier ("GPL-3.0 OR PROPRIETARY"). Nobody used it — 0 of 1410 pages — and
// keeping it would have forced a licence decision the day any closed part
// exists. Ours is below in blocks.tsx.
export const saltSchema =
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      callout: calloutSpec(),
      toc: tocSpec(),
      subpages: subpagesSpec(),
      bookmark: bookmarkSpec(),
      database: databaseSpec(),
      columns: columnsSpec(),
      mermaid: mermaidSpec(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      pageLink: pageLinkSpec,
    },
  });

export type SaltEditor = typeof saltSchema.BlockNoteEditor;
