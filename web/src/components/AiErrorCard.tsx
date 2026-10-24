import { useState, useMemo } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, RotateCcw, X, AlertTriangle } from 'lucide-react';
import { t } from '../i18n';

export interface ParsedAiError {
  category: 'auth' | 'quota' | 'rate_limit' | 'model' | 'context' | 'timeout' | 'server' | 'disabled' | 'unknown';
  categoryLabel: string;
  message: string;
  hint?: string;
  raw: string;
  code?: string;
  status?: number;
}

export function parseAiError(rawError: string): ParsedAiError {
  const raw = String(rawError || '').trim();
  let msg = raw;
  let code = '';
  let status: number | undefined;

  // Attempt to parse JSON error responses (from OpenAI, Anthropic, Ollama, Go server, etc.)
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object') {
        msg = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error);
        code = parsed.error.code || parsed.error.type || '';
      } else if (typeof parsed.error === 'string') {
        // Handle double-encoded JSON like {"error": "{\"error\":{\"message\":\"...\"}}"}
        try {
          const inner = JSON.parse(parsed.error);
          if (inner?.error?.message) {
            msg = inner.error.message;
            code = inner.error.code || inner.error.type || '';
          } else {
            msg = parsed.error;
          }
        } catch {
          msg = parsed.error;
        }
      } else if (parsed.message && typeof parsed.message === 'string') {
        msg = parsed.message;
        code = parsed.code || '';
      }
      if (typeof parsed.status === 'number') status = parsed.status;
    }
  } catch {
    /* not JSON, use raw text */
  }

  const lower = (raw + ' ' + msg + ' ' + code).toLowerCase();

  if (
    lower.includes('invalid_api_key') ||
    lower.includes('incorrect api key') ||
    lower.includes('no api key') ||
    lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('invalid token') ||
    lower.includes('api key expired')
  ) {
    return {
      category: 'auth',
      categoryLabel: t('Authentication error'),
      message: msg,
      hint: t('Check your API key in Admin Settings → AI Agent.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('insufficient_quota') ||
    lower.includes('quota') ||
    lower.includes('billing') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('credit balance')
  ) {
    return {
      category: 'quota',
      categoryLabel: t('Quota exceeded'),
      message: msg,
      hint: t('Check your provider account balance and billing limits.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('tokens per minute') ||
    lower.includes('requests per minute')
  ) {
    return {
      category: 'rate_limit',
      categoryLabel: t('Rate limit reached'),
      message: msg,
      hint: t('Too many requests. Please wait a moment before retrying.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('model_not_found') ||
    lower.includes('model not found') ||
    lower.includes('does not exist') ||
    lower.includes('model unavailable') ||
    lower.includes('access to model')
  ) {
    return {
      category: 'model',
      categoryLabel: t('Model unavailable'),
      message: msg,
      hint: t('Verify the model name configured in Admin Settings.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('context_length_exceeded') ||
    lower.includes('maximum context length') ||
    lower.includes('too many tokens') ||
    lower.includes('token limit')
  ) {
    return {
      category: 'context',
      categoryLabel: t('Context limit exceeded'),
      message: msg,
      hint: t('The prompt or context is too long. Try detaching large files or starting a new chat.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline exceeded') ||
    lower.includes('connection refused') ||
    lower.includes('network error') ||
    lower.includes('failed to fetch') ||
    lower.includes('no connection')
  ) {
    return {
      category: 'timeout',
      categoryLabel: t('Connection timeout'),
      message: msg,
      hint: t('Could not connect to the AI server. Check your connection or Base URL.'),
      raw,
      code,
      status,
    };
  }

  if (lower.includes('ai is disabled')) {
    return {
      category: 'disabled',
      categoryLabel: t('AI disabled'),
      message: msg,
      hint: t('Enable the AI Agent in Admin Settings.'),
      raw,
      code,
      status,
    };
  }

  if (
    lower.includes('overloaded') ||
    lower.includes('service unavailable') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('502') ||
    lower.includes('503')
  ) {
    return {
      category: 'server',
      categoryLabel: t('Provider service error'),
      message: msg,
      hint: t('The AI service is experiencing issues. Please try again shortly.'),
      raw,
      code,
      status,
    };
  }

  return {
    category: 'unknown',
    categoryLabel: t('Server error'),
    message: msg || t('Agent encountered an error'),
    hint: t('See details below or copy the raw server response.'),
    raw,
    code,
    status,
  };
}

export default function AiErrorCard(props: {
  error: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const parsed = useMemo(() => parseAiError(props.error), [props.error]);

  const copyResponse = async () => {
    try {
      await navigator.clipboard.writeText(parsed.raw || props.error);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard fallback */
    }
  };

  return (
    <div className="ai-error-card">
      <div className="ai-error-head">
        <AlertTriangle size={15} className="ai-error-icon" />
        <span className="ai-error-category">{parsed.categoryLabel}</span>
        {parsed.code && <span className="ai-error-code-badge">{parsed.code}</span>}
      </div>

      <div className="ai-error-body">
        <div className="ai-error-message">{parsed.message}</div>
        {parsed.hint && <div className="ai-error-hint">{parsed.hint}</div>}
      </div>

      {showDetails && (
        <div className="ai-error-details">
          <pre>{parsed.raw}</pre>
        </div>
      )}

      <div className="ai-error-actions">
        {props.onRetry && (
          <button className="btn-sm primary" onClick={props.onRetry} type="button">
            <RotateCcw size={12} style={{ marginRight: 4 }} />
            {t('Retry')}
          </button>
        )}
        <button
          className="btn-sm"
          onClick={() => void copyResponse()}
          type="button"
          title={t('Copy server response')}
        >
          {copied ? (
            <>
              <Check size={12} style={{ marginRight: 4, color: 'var(--success, #22c55e)' }} />
              {t('Copied')}
            </>
          ) : (
            <>
              <Copy size={12} style={{ marginRight: 4 }} />
              {t('Copy response')}
            </>
          )}
        </button>
        <button
          className="btn-sm"
          onClick={() => setShowDetails((v) => !v)}
          type="button"
          title={showDetails ? t('Hide details') : t('Show details')}
        >
          {showDetails ? (
            <>
              <ChevronUp size={12} style={{ marginRight: 4 }} />
              {t('Hide details')}
            </>
          ) : (
            <>
              <ChevronDown size={12} style={{ marginRight: 4 }} />
              {t('Details')}
            </>
          )}
        </button>
        {props.onDismiss && (
          <button className="btn-sm" onClick={props.onDismiss} type="button" title={t('Dismiss')}>
            <X size={12} style={{ marginRight: 4 }} />
            {t('Dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
