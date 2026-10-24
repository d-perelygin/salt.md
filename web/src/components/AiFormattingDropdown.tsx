import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ChevronDown, Check, X, ArrowUp, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import AiErrorCard from './AiErrorCard';

export default function AiFormattingDropdown(props: {
  editor: any;
  pageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [lastPrompt, setLastPrompt] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      if (!busy) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, busy]);

  const getSelection = () => {
    try {
      return props.editor.getSelectedText?.() ?? '';
    } catch {
      return '';
    }
  };

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const top = Math.min(r.bottom + 6, window.innerHeight - 260);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 260));
      setCoords({ top, left });
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  const run = async (instruction: string) => {
    const sel = getSelection();
    if (!sel || busy) return;
    setBusy(true);
    setResult('');
    setError('');
    setLastPrompt(instruction);
    let acc = '';
    try {
      const res = await api.generateAI({
        prompt: instruction,
        selection: sel,
        pageId: props.pageId,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(errBody || t('Generation failed. Please try again.'));
      }
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
    } catch (err: any) {
      setError(err?.message || t('Generation failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const replace = () => {
    if (!result) return;
    try {
      const view = props.editor.prosemirrorView;
      const { from, to } = view.state.selection;
      const tr = view.state.tr.insertText(result, from, to);
      view.dispatch(tr);
    } catch {}
    setResult('');
    setOpen(false);
  };

  const askInChat = () => {
    const sel = getSelection();
    window.dispatchEvent(
      new CustomEvent('salt:ai-ask', {
        detail: { pageId: props.pageId, selection: sel },
      }),
    );
    setOpen(false);
  };

  const submitCustom = () => {
    if (!prompt.trim() || busy) return;
    void run(prompt.trim());
    setPrompt('');
  };

  return (
    <div className="ai-fmt-wrap" style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        className="ai-fmt-btn"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={toggle}
        title={t('AI Actions')}
      >
        <Sparkles size={14} style={{ color: 'var(--accent)' }} />
        <span>AI</span>
        <ChevronDown size={12} style={{ opacity: 0.6 }} />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className="ai-fmt-dropdown"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              zIndex: 99999,
            }}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement)?.tagName !== 'INPUT') {
                e.preventDefault();
              }
            }}
          >
            {!result && !busy && (
              <>
                <button
                  type="button"
                  className="ai-fmt-item"
                  onClick={() => void run('Rewrite the selected text to be clearer and more concise.')}
                >
                  <span className="ai-fmt-item-icon">🪄</span>
                  <span>{t('Rewrite')}</span>
                </button>
                <button
                  type="button"
                  className="ai-fmt-item"
                  onClick={() => void run('Summarize the selected text concisely.')}
                >
                  <span className="ai-fmt-item-icon">📝</span>
                  <span>{t('Summarize')}</span>
                </button>
                <button
                  type="button"
                  className="ai-fmt-item"
                  onClick={() => void run('Translate the selected text to English.')}
                >
                  <span className="ai-fmt-item-icon">🌐</span>
                  <span>{t('Translate')}</span>
                </button>
                <button
                  type="button"
                  className="ai-fmt-item"
                  onClick={() => void run('Fix grammar, spelling, and punctuation in the selected text.')}
                >
                  <span className="ai-fmt-item-icon">✍️</span>
                  <span>{t('Fix grammar')}</span>
                </button>

                <div className="ai-fmt-custom-row">
                  <input
                    type="text"
                    className="ai-fmt-input"
                    placeholder={t('Custom instruction…')}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitCustom();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ai-fmt-go"
                    disabled={!prompt.trim()}
                    onClick={submitCustom}
                  >
                    <ArrowUp size={13} />
                  </button>
                </div>

                <div className="ai-dropdown-divider" />

                <button
                  type="button"
                  className="ai-fmt-item"
                  onClick={askInChat}
                >
                  <span className="ai-fmt-item-icon">💬</span>
                  <span>{t('Ask in chat')}</span>
                </button>
              </>
            )}

            {busy && !result && (
              <div className="ai-fmt-busy">
                <RefreshCw size={14} className="spin" style={{ color: 'var(--accent)' }} />
                <span>{t('AI is thinking…')}</span>
              </div>
            )}

            {error && (
              <div style={{ padding: '0 8px 8px' }}>
                <AiErrorCard
                  error={error}
                  onRetry={lastPrompt ? () => void run(lastPrompt) : undefined}
                  onDismiss={() => setError('')}
                />
              </div>
            )}

            {result && (
              <div className="ai-fmt-result-box">
                <div className="ai-fmt-result-text">{result}</div>
                <div className="ai-fmt-result-actions">
                  <button
                    type="button"
                    className="btn-sm primary"
                    style={{ background: 'var(--accent)', color: 'var(--accent-fg, #fff)' }}
                    onClick={replace}
                  >
                    <Check size={13} style={{ marginRight: 4 }} />
                    {t('Replace')}
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => setResult('')}
                  >
                    <X size={13} style={{ marginRight: 4 }} />
                    {t('Dismiss')}
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
