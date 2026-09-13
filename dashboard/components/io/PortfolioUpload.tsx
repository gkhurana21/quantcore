'use client';

import { useRef, useState } from 'react';
import type { Market, Leg } from '@/lib/quant/types';
import type { PortfolioImport } from '@/lib/io/portfolioParser';
import { COLUMN_DOCS, importPortfolio, parseCsvText } from '@/lib/io/portfolioParser';
import { readSpreadsheet, workbookBlob } from '@/lib/io/spreadsheet';
import { SAMPLE_CSV, SAMPLE_ROWS } from '@/lib/io/samples';
import { MAX_LEGS } from '@/lib/strategy/presets';
import { num, usdSigned } from '@/lib/format';
import { Button, cx, ui } from '@/components/ui/primitives';
import io from './io.module.css';

const MAX_BYTES = 5_000_000;

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function PortfolioUpload({ market, symbol, onApply }: {
  market: Market; symbol: string; onApply: (legs: Leg[], label: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<{ name: string; result: PortfolioImport } | null>(null);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    setError(''); setStatus(''); setPreview(null);
    if (file.size > MAX_BYTES) { setError(`${file.name} is larger than 5 MB.`); return; }
    const isSheet = /\.(xlsx|xlsm|xls|ods)$/i.test(file.name);
    const isText = /\.(csv|tsv|txt)$/i.test(file.name) || file.type.startsWith('text/');
    if (!isSheet && !isText) { setError('Unsupported file type — use .csv, .xlsx or .xls.'); return; }
    setBusy(true);
    try {
      const table = isSheet ? await readSpreadsheet(await file.arrayBuffer()) : parseCsvText(await file.text());
      const result = importPortfolio(table, { market, instrument: symbol, today: new Date(), maxLegs: MAX_LEGS });
      setPreview({ name: file.name, result });
      setStatus(result.legs.length
        ? `${file.name}: ${result.legs.length} position${result.legs.length > 1 ? 's' : ''} ready to apply`
        : `${file.name}: no valid positions`);
    } catch (err) {
      setError(`Could not read ${file.name}${isSheet ? ' as a workbook' : ''}: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview?.result.legs.length) return;
    onApply(preview.result.legs, preview.name);
    setStatus(`Applied ${preview.result.legs.length} position${preview.result.legs.length > 1 ? 's' : ''} from ${preview.name}`);
    setPreview(null);
  };

  const r = preview?.result;
  const sum = r?.summary;

  return (
    <div>
      <div className={cx(io.drop, drag && io.dropActive)} role="button" tabIndex={0} data-testid="upload-dropzone"
           aria-label="Upload a portfolio file (CSV, XLSX or XLS). Processed locally in your browser."
           onClick={() => inputRef.current?.click()}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
           onDragOver={e => { e.preventDefault(); setDrag(true); }}
           onDragLeave={() => setDrag(false)}
           onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files?.[0]); }}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className={io.dropIcon}>
          <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={io.dropText}>{busy ? 'Parsing…' : <>Drop a <b>CSV</b> or <b>Excel</b> file, or click to browse</>}</span>
        <span className={io.dropHint}>.csv · .xlsx · .xls — up to {MAX_LEGS} legs</span>
      </div>
      <input ref={inputRef} type="file" className="sr-only" data-testid="upload-input" tabIndex={-1}
             aria-label="Portfolio file (CSV, XLSX or XLS)"
             accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
             onChange={e => { handleFile(e.target.files?.[0]); e.target.value = ''; }} />

      <p className={io.privacy} data-testid="upload-privacy">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V8a6 6 0 1 1 12 0v2m-13 0h14v11H5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
        Processed locally in your browser — files never leave your device.
      </p>

      <div className={io.samples}>
        <Button size="sm" variant="ghost" data-testid="sample-csv"
                onClick={() => saveBlob(new Blob([SAMPLE_CSV], { type: 'text/csv' }), 'quantcore-sample-portfolio.csv')}>
          ↓ Sample CSV
        </Button>
        <Button size="sm" variant="ghost" data-testid="sample-xlsx"
                onClick={async () => saveBlob(await workbookBlob(SAMPLE_ROWS), 'quantcore-sample-portfolio.xlsx')}>
          ↓ Sample XLSX
        </Button>
        <Button size="sm" variant="ghost" data-testid="sample-load"
                onClick={() => {
                  const result = importPortfolio(parseCsvText(SAMPLE_CSV), { market, instrument: symbol, today: new Date(), maxLegs: MAX_LEGS });
                  setError(''); setPreview({ name: 'sample portfolio', result });
                  setStatus(`sample portfolio: ${result.legs.length} positions ready to apply`);
                }}>
          Preview sample
        </Button>
      </div>

      {error && <p className={io.error} role="alert" data-testid="upload-error">{error}</p>}
      <p className="sr-only" role="status" data-testid="upload-status">{status}</p>

      {r && (
        <div className={io.preview} data-testid="upload-preview">
          <div className={io.previewHead}>
            <span className={io.fileName}>{preview!.name}</span>
            <span className={io.mapping}>
              {r.headerless ? 'no header · columns read as type, strike, days, qty, premium'
                : `mapped ${Object.keys(r.mapping).length} columns`}
            </span>
          </div>

          {sum && (
            <dl className={io.summary} data-testid="upload-summary">
              <div><dt>Positions</dt><dd>{sum.positions}</dd></div>
              <div><dt>Calls / puts</dt><dd>{sum.calls} / {sum.puts}</dd></div>
              <div><dt>Long / short</dt><dd>{sum.long} / {sum.short}</dd></div>
              <div><dt>Net premium</dt><dd>{usdSigned(-sum.netPremium)}</dd></div>
              <div><dt>DTE</dt><dd>{sum.minDays === sum.maxDays ? sum.minDays : `${sum.minDays}–${sum.maxDays}`}</dd></div>
            </dl>
          )}

          {r.errors.map(e => <p key={e} className={io.error}>{e}</p>)}
          {r.warnings.map(w => <p key={w} className={io.warning}>{w}</p>)}

          {r.rows.length > 0 && (
            <div className={cx(ui.tableWrap, io.rowsWrap)}>
              <table className={cx(ui.table, io.rows)}>
                <thead>
                  <tr><th>Line</th><th>Type</th><th>Side</th><th className={ui.num}>Strike</th><th className={ui.num}>DTE</th>
                    <th className={ui.num}>Qty</th><th className={ui.num}>Premium</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {r.rows.slice(0, 60).map(row => (
                    <tr key={row.line} data-testid="upload-row" data-ok={!row.errors.length}>
                      <td className={ui.num}>{row.line}</td>
                      {row.leg ? (
                        <>
                          <td>{row.leg.call ? 'Call' : 'Put'}</td>
                          <td>{row.leg.side === 'buy' ? 'Buy' : 'Sell'}</td>
                          <td className={ui.num}>{num(row.leg.K, 2)}</td>
                          <td className={ui.num}>{Math.round(row.leg.T * 365)}</td>
                          <td className={ui.num}>{row.leg.qty}</td>
                          <td className={ui.num}>{row.leg.premium.toFixed(2)}</td>
                          <td className={io.ok}>✓{row.warnings.length ? ` ${row.warnings[0]}` : ''}</td>
                        </>
                      ) : (
                        <td colSpan={7} className={io.rowError} title={row.cells.join(' | ')}>✗ {row.errors.join('; ')}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={io.actions}>
            <Button variant="primary" size="sm" data-testid="upload-apply" disabled={!r.legs.length} onClick={apply}>
              Apply {r.legs.length || ''} position{r.legs.length === 1 ? '' : 's'}
            </Button>
            <Button size="sm" variant="ghost" data-testid="upload-discard" onClick={() => { setPreview(null); setStatus('Import discarded'); }}>
              Discard
            </Button>
          </div>
        </div>
      )}

      <details className={io.docs}>
        <summary>Accepted columns</summary>
        <table className={cx(ui.table, io.docsTable)}>
          <thead><tr><th>Column</th><th>Required</th><th>Also accepted</th></tr></thead>
          <tbody>
            {COLUMN_DOCS.map(d => (
              <tr key={d.column}><td className="mono">{d.column}</td><td>{d.required}</td><td className={io.aliases}>{d.aliases}</td></tr>
            ))}
          </tbody>
        </table>
        <p className={ui.note}>
          Header names are matched case- and punctuation-insensitively. Expiry may be a date (ISO, US M/D/Y,
          Excel date or serial) or days-to-expiry. Negative quantity or “short/sell” marks a short leg.
          Positions are priced on the selected underlying.
        </p>
      </details>
    </div>
  );
}
