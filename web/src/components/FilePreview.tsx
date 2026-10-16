import { useEffect, useRef, useState } from 'react';
import Portal from './Portal';
import { useExclusiveModal } from '../modal';
import { t } from '../i18n';
import { formatBytes } from '../format';

// Files that open in a viewer instead of the download folder. PDF is rendered
// by the browser itself, so it costs no library and no server-side conversion.
// Office formats (.docx/.xlsx) are rendered locally in the browser with lazy
// loaded libraries — nothing leaves the machine, the single binary stays one
// binary, and no online viewer ever sees the documents. The preview is a quick
// look, not pixel-perfect Word: complex layout may differ.
const PREVIEWABLE = /\.(pdf|docx|xlsx)$/i;

// Above this the file renders straight away; below the choice is the user's,
// because a 50 MB spreadsheet can freeze a phone. The bytes are already
// fetched at that point (one download, kept in memory), so "render anyway"
// never downloads twice.
const LARGE_PREVIEW_BYTES = 10 * 1024 * 1024;

// A huge sheet would build a DOM of tens of thousands of nodes and hang the
// tab. The full file is one Download away; the preview shows the head of it.
const SHEET_ROW_CAP = 500;
const SHEET_COL_CAP = 50;

type OfficeKind = 'docx' | 'xlsx';

function officeKindOf(url: string): OfficeKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(url.split('?')[0].split('#')[0]);
  const ext = (m?.[1] ?? '').toLowerCase();
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  return null;
}

// Only same-origin uploads. A file block's URL can also be a foreign address
// (the block's "Embed" tab takes any URL), and those must keep opening the
// normal way: /files/ is the one path that carries the sandbox CSP, so it is
// also the only one whose contents we are willing to fetch and render.
export function isPreviewable(url: string): boolean {
  return url.startsWith('/files/') && PREVIEWABLE.test(url);
}

export function FilePreview({
  name,
  url,
  onClose,
}: {
  name: string;
  url: string;
  onClose: () => void;
}) {
  useExclusiveModal(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind = officeKindOf(url);

  return (
    <Portal>
      <div
        className="modal-overlay file-preview-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="file-preview" role="dialog" aria-modal="true" aria-label={name}>
          <div className="file-preview-bar">
            <span className="file-preview-name" title={name}>
              {name}
            </span>
            {/* A plain link, not fetch+blob: the browser already sends the
                session cookie, and download= keeps the readable name instead
                of the random id the file is stored under. */}
            <a className="btn-sm" href={url} download={name}>
              {t('Download')}
            </a>
            <button className="btn-sm" onClick={onClose}>
              {t('Close')}
            </button>
          </div>
          {kind ? (
            <OfficePreview name={name} url={url} kind={kind} />
          ) : (
            <iframe className="file-preview-frame" src={url} title={name} />
          )}
        </div>
      </div>
    </Portal>
  );
}

function OfficePreview({ name, url, kind }: { name: string; url: string; kind: OfficeKind }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    fetch(url, { credentials: 'same-origin', signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((b) => alive && setBlob(b))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [url]);

  if (loadError) {
    return (
      <div className="file-preview-body">
        <div className="office-center">
          <p>{t('Could not render this file.')}</p>
          <a className="btn-sm" href={url} download={name}>
            {t('Download')}
          </a>
        </div>
      </div>
    );
  }
  if (!blob) {
    return (
      <div className="file-preview-body">
        <div className="office-center">{t('Loading…')}</div>
      </div>
    );
  }
  if (blob.size > LARGE_PREVIEW_BYTES && !confirmed) {
    return (
      <div className="file-preview-body">
        <div className="office-center">
          <p>{t('This file is large ({size}). Rendering may be slow.', { size: formatBytes(blob.size) })}</p>
          <div className="office-actions">
            <button className="btn-sm" onClick={() => setConfirmed(true)}>
              {t('Render anyway')}
            </button>
            <a className="btn-sm" href={url} download={name}>
              {t('Download')}
            </a>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="file-preview-body">
      <div className="office-disclaimer">{t('Quick preview — formatting may differ from Word')}</div>
      {kind === 'docx' ? <DocxView blob={blob} /> : <XlsxView blob={blob} name={name} url={url} />}
    </div>
  );
}

function DocxView({ blob }: { blob: Blob }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    // Lazy so the main bundle stays lean for readers who never open Office
    // files. docx-preview renders into the element, including its own page
    // styles; a corrupt file rejects and we show the fallback, never a hang.
    import('docx-preview')
      .then((m) => (alive ? m.renderAsync(blob, host) : null))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [blob]);

  if (failed) return <div className="office-center">{t('Could not render this file.')}</div>;
  return <div ref={hostRef} className="office-docx" />;
}

type SheetGrid = { rows: string[][]; totalRows: number; truncatedCols: boolean };

function XlsxView({ blob, name, url }: { blob: Blob; name: string; url: string }) {
  const [book, setBook] = useState<{ names: string[]; grids: SheetGrid[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    // Same lazy reasoning as docx: SheetJS is only paid for when a
    // spreadsheet is actually opened.
    import('xlsx')
      .then((m) => blob.arrayBuffer().then((buf) => ({ m, buf })))
      .then(({ m, buf }) => {
        if (!alive) return;
        const wb = m.read(buf, { type: 'array' });
        const names: string[] = wb.SheetNames.length ? wb.SheetNames : ['Sheet1'];
        const grids: SheetGrid[] = names.map((n) => {
          const ws = wb.Sheets[n];
          const raw = (ws ? m.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }) : []) as unknown[][];
          const totalRows = raw.length;
          const rows = raw
            .slice(0, SHEET_ROW_CAP)
            .map((r) => (Array.isArray(r) ? r : []).slice(0, SHEET_COL_CAP).map((c) => String(c ?? '')));
          return {
            rows,
            totalRows,
            truncatedCols: raw.some((r) => Array.isArray(r) && r.length > SHEET_COL_CAP),
          };
        });
        setBook({ names, grids });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [blob]);

  if (failed) {
    return (
      <div className="office-center">
        <p>{t('Could not render this file.')}</p>
        <a className="btn-sm" href={url} download={name}>
          {t('Download')}
        </a>
      </div>
    );
  }
  if (!book) return <div className="office-center">{t('Loading…')}</div>;
  const grid = book.grids[Math.min(active, book.grids.length - 1)];
  const colCount = grid.rows.reduce((n, r) => Math.max(n, r.length), 0);

  return (
    <div className="office-sheet">
      {book.names.length > 1 && (
        <div className="office-tabs" role="tablist">
          {book.names.map((n, i) => (
            <button
              key={n + i}
              role="tab"
              aria-selected={i === active}
              className={'office-tab' + (i === active ? ' is-active' : '')}
              onClick={() => setActive(i)}
              title={n}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {(grid.totalRows > SHEET_ROW_CAP || grid.truncatedCols) && (
        <div className="office-cut">
          {grid.totalRows > SHEET_ROW_CAP
            ? t('Showing first {shown} of {total} rows', { shown: grid.rows.length, total: grid.totalRows })
            : null}
        </div>
      )}
      <div className="office-table-wrap">
        <table className="office-table">
          <tbody>
            {grid.rows.map((r, i) => (
              <tr key={i}>
                {Array.from({ length: colCount }).map((_, j) => (
                  <td key={j}>{r[j] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
