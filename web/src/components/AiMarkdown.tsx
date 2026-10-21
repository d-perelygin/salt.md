import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Safe markdown rendering for AI chat messages (assistant output is
// model-generated, so raw HTML must not reach the DOM unfiltered).
export default function AiMarkdown({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(text, { async: false, breaks: true }) as string;
      return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    } catch {
      return '';
    }
  }, [text]);
  if (!text) return null;
  if (!html) return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
  // Internal page links (/p/<id> or /p/<slug>-<id>) open in place through
  // the app's navigation event instead of reloading the whole page.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest?.('a') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const m = /\/p\/(?:.*-)?([0-9a-f]{32})\/?$/i.exec(href);
    if (m) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('salt:navigate', { detail: m[1] }));
    } else if (href.startsWith('/')) {
      e.preventDefault();
    }
  };
  return (
    <span
      className="ai-markdown"
      style={{ overflowWrap: 'anywhere' }}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
