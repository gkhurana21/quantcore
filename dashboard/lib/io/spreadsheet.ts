// SheetJS is loaded on demand so the ~400 kB parser never ships in the initial
// bundle — it is fetched only when a user uploads a workbook or downloads the
// sample XLSX. All parsing happens in the browser.

export async function readSpreadsheet(buf: ArrayBuffer): Promise<unknown[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
  const name = wb.SheetNames[0];
  if (!name) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1, raw: true, defval: '', blankrows: false,
  });
}

export async function workbookBlob(rows: (string | number)[][], sheetName = 'Portfolio'): Promise<Blob> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
