import { useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import type { PageMeta } from '../types';

type GenKind = 'custom' | 'summarize' | 'points' | 'translate';

const KINDS: { id: GenKind }[] = [{ id: 'custom' }, { id: 'summarize' }, { id: 'points' }, { id: 'translate' }];

function kindLabel(k: GenKind): string {
  if (k === 'summarize') return t('Summarize');
  if (k === 'points') return t('Key points');
  if (k === 'translate') return t('Translate');
  return t('Custom output');
}

// Notion-style AI block composer: generates content into the document.
// Ephemeral — nothing is saved to chats.
export default function AiBlockComposer(props: {
  pageId: string;
  selection: string;
  pagesById?: Map<string, PageMeta>;
  onClose: () => void;
  onInserted: () => void;
}) {
  const [kind, setKind] = useState<GenKind>('custom');
  const [prompt, setPrompt] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  function onPromptChange(v: string) {
    setPrompt(v);
    const m = v.match(/@([^@]{0,60})$/);
    setMentionQuery(m ? m[1] : null);
  }

  function mentionMatches(): PageMeta[] {
    const all = props.pagesById ? [...props.pagesById.values()] : [];
    const q = (mentionQuery ?? '').toLowerCase();
    return all
      .filter((p) => !p.trashed && p.id !== props.pageId)
      .filter((p) => (p.title || t('Untitled')).toLowerCase().includes(q))
      .slice(0, 8);
  }

  function resolveMentions(text: string): { id: string; title: string }[] {
    if (!props.pagesById) return [];
    const out: { id: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const p of props.pagesById.values()) {
      if (p.trashed || seen.has(p.id)) continue;
      if (text.includes('@' + (p.title || t('Untitled')))) {
        seen.add(p.id);
        out.push({ id: p.id, title: p.title || t('Untitled') });
      }
    }
    return out.slice(0, 8);
  }

  function instruction(): string {
    const sel = props.selection ? `\n\nText to work with:\n${props.selection}` : '';
    if (kind === 'summarize') return 'Summarize the following concisely.' + sel;
    if (kind === 'points') return 'Extract the key points as a short bullet list.' + sel;
    if (kind === 'translate') return 'Translate the following to English. Reply with only the translation.' + sel;
    return (prompt.trim() || 'Generate content.') + sel;
  }

  async function generate() {
    if (busy) return;
    if (kind === 'custom' && !prompt.trim() && !props.selection) return;
    setBusy(true);
    setResult('');
    try {
      const res = await api.generateAI({
        prompt: instruction(),
        selection: props.selection || undefined,
        pageId: props.pageId,
        includePage: kind !== 'custom' || !props.selection,
        mentions: resolveMentions(prompt).map((m) => m.id),
      });
      const full = await res.text();
      let acc = '';
      for (const line of full.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.type === 'delta') acc += j.content;
        } catch { /* ignore */ }
      }
      setResult(acc);
    } catch {
      setResult('');
    } finally {
      setBusy(false);
    }
  }

  function insert() {
    if (!result) return;
    window.dispatchEvent(new CustomEvent('salt:ai-insert', {
      detail: { pageId: props.pageId, markdown: result },
    }));
    props.onInserted();
    props.onClose();
  }

  return (
    <div style={{
      position: 'fixed', left: '50%', top: '12%', transform: 'translateX(-50%)',
      width: 640, maxWidth: 'calc(100vw - 32px)', zIndex: 1100,
      background: 'var(--card)', color: 'var(--card-foreground)',
      border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 16px 48px rgba(0,0,0,.35)', padding: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <strong style={{ fontSize: 16 }}>{t('AI block')}</strong>
        <button className="btn-sm primary" onClick={props.onClose}>{t('Done')}</button>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('Generate')}</div>
      <select value={kind} onChange={(e) => setKind(e.target.value as GenKind)} style={{ width: '100%', marginBottom: 12, padding: 8, borderRadius: 8 }}>
        {KINDS.map((k) => <option key={k.id} value={k.id}>{kindLabel(k.id)}</option>)}
      </select>
      {kind === 'custom' && (
        <div style={{ position: 'relative' }}>
          {mentionQuery !== null && mentionMatches().length > 0 && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 50,
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxHeight: 220, overflow: 'auto', minWidth: 260,
            }}>
              {mentionMatches().map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    const title = p.title || t('Untitled');
                    setPrompt((cur) => cur.replace(/@[^@]{0,60}$/, '@' + title + ' '));
                    setMentionQuery(null);
                  }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '8px 12px', fontSize: 14 }}
                >
                  📄 {p.title || t('Untitled')}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder={t('Describe the content that should be generated.')}
            rows={5}
            style={{ width: '100%', marginBottom: 12, padding: 10, borderRadius: 8, resize: 'vertical' }}
          />
        </div>
      )}
      {props.selection && (
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12, maxHeight: 60, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          ❝ {props.selection.slice(0, 300)}{props.selection.length > 300 ? '…' : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn-sm primary" onClick={() => void generate()} disabled={busy}>
          {busy ? '…' : t('Generate')}
        </button>
        {result && (
          <>
            <button className="btn-sm" onClick={insert}>{t('Insert')}</button>
            <button className="btn-sm" onClick={() => setResult('')}>{t('Discard')}</button>
          </>
        )}
      </div>
      {result && (
        <div style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', padding: 10, background: 'var(--muted)', borderRadius: 8, fontSize: 14 }}>
          {result}
        </div>
      )}
      <div style={{ fontWeight: 600, margin: '12px 0 8px' }}>{t('Using')}</div>
      <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8, opacity: 0.8, fontSize: 14 }}>
        📄 {t('Current page only')}
      </div>
    </div>
  );
}
