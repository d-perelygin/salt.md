import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';

export default function AiInlineAssistant(props: { editor: any; pageId: string }) {
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    const unsub = props.editor.onSelectionChange(() => {
      try {
        const text = props.editor.getSelectedText?.() ?? '';
        setSelection(text.trim() ? text : '');
        if (!text.trim()) setResult('');
      } catch {
        // ignore
      }
    });
    return () => {
      try { unsub(); } catch {}
    };
  }, [props.editor]);

  // Ephemeral: inline rewrites never touch the chat history.
  async function run(instruction: string) {
    if (!selection || busy) return;
    setBusy(true);
    setResult('');
    let acc = '';
    try {
      const res = await api.generateAI({ prompt: instruction, selection, pageId: props.pageId });
      if (!res.ok) throw new Error('failed');
      const full = await res.text();
      for (const line of full.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.type === 'delta') {
            acc += j.content;
            setResult(acc);
          }
        } catch {}
      }
    } catch {
      setResult((r) => r + '\n[error]');
    } finally {
      setBusy(false);
    }
  }

  function replace() {
    if (!result) return;
    try {
      const view = props.editor.prosemirrorView;
      const { from, to } = view.state.selection;
      const tr = view.state.tr.insertText(result, from, to);
      view.dispatch(tr);
    } catch {}
    setResult('');
    setSelection('');
  }

  if (!selection) return null;

  return (
    <div style={{ position: 'absolute', right: 12, top: 12, zIndex: 50, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, width: 320, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>
      <div style={{ fontSize: 12, opacity: .7, marginBottom: 6 }}>{t('Selection')}: {selection.slice(0, 60)}{selection.length > 60 ? '…' : ''}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <button disabled={busy} onClick={() => run('Rewrite the selected text to be clearer and more concise.')} className="btn-sm">{t('Rewrite')}</button>
        <button disabled={busy} onClick={() => run('Summarize the selected text.')} className="btn-sm">{t('Summarize')}</button>
        <button disabled={busy} onClick={() => run('Translate the selected text to English.')} className="btn-sm">{t('Translate')}</button>
        <button disabled={busy} onClick={() => run('Fix grammar and spelling in the selected text.')} className="btn-sm">{t('Fix grammar')}</button>
      </div>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('Custom instruction')} style={{ width: '100%', marginBottom: 6 }} />
      <button disabled={busy || !prompt.trim()} onClick={() => { run(prompt); setPrompt(''); }} className="btn-sm">{t('Ask')}</button>
      {result && (
        <div style={{ marginTop: 8 }}>
          <div style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', padding: 6, background: 'var(--muted)', borderRadius: 6, fontSize: 13 }}>{result}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={replace} className="btn-sm primary">{t('Replace')}</button>
            <button onClick={() => { setResult(''); }} className="btn-sm">{t('Dismiss')}</button>
          </div>
        </div>
      )}
      {busy && <div style={{ marginTop: 6, fontSize: 12 }}>…</div>}
    </div>
  );
}
