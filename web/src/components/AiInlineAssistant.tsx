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

  const opts: { label: string; instruction: string }[] = [
    { label: t('Rewrite'), instruction: 'Rewrite the selected text to be clearer and more concise.' },
    { label: t('Summarize'), instruction: 'Summarize the selected text.' },
    { label: t('Translate'), instruction: 'Translate the selected text to English.' },
    { label: t('Fix grammar'), instruction: 'Fix grammar and spelling in the selected text.' },
  ];

  function submitCustom() {
    if (!prompt.trim()) return;
    run(prompt);
    setPrompt('');
  }

  return (
    <div className="ai-inline-wrap">
      <div className="ai-inline-bar">
        <span className="ai-inline-spark" title={t('AI')}>✨</span>
        {opts.map((o) => (
          <button key={o.label} className="ai-inline-opt" disabled={busy} onClick={() => run(o.instruction)}>
            {o.label}
          </button>
        ))}
        <input
          className="ai-inline-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitCustom(); } }}
          placeholder={t('Custom instruction…')}
          disabled={busy}
        />
        <button className="ai-inline-go" disabled={busy || !prompt.trim()} onClick={submitCustom} title={t('Ask')}>↑</button>
      </div>
      {result && (
        <div className="ai-inline-result">
          <div className="ai-inline-result-text">{result}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={replace} className="btn-sm primary">{t('Replace')}</button>
            <button onClick={() => { setResult(''); }} className="btn-sm">{t('Dismiss')}</button>
          </div>
        </div>
      )}
      {busy && !result && <div className="ai-inline-busy">…</div>}
    </div>
  );
}
