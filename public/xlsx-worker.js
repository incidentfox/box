'use strict';

// Parse spreadsheets off the main thread so a large workbook cannot freeze the phone UI.
// SheetJS CE is pinned and vendored locally; workbook contents never leave the Box host/browser.
importScripts('/vendor/xlsx.full.min.js');

const clamp = (value, fallback, max) => Math.min(max, Math.max(1, Number(value) || fallback));

self.onmessage = (event) => {
  try {
    const maxRows = clamp(event.data && event.data.maxRows, 250, 500);
    const maxCols = clamp(event.data && event.data.maxCols, 50, 100);
    const maxSheets = clamp(event.data && event.data.maxSheets, 20, 50);
    const workbook = XLSX.read(event.data.buffer, { type: 'array', cellDates: true, dense: true });
    const names = workbook.SheetNames || [];
    const sheets = names.slice(0, maxSheets).map((name) => {
      const sheet = workbook.Sheets[name];
      if (!sheet || !sheet['!ref']) return { name, rows: [], startRow: 0, startCol: 0, totalRows: 0, totalCols: 0, truncated: false };
      const used = XLSX.utils.decode_range(sheet['!ref']);
      const totalRows = used.e.r - used.s.r + 1;
      const totalCols = used.e.c - used.s.c + 1;
      const range = {
        s: { r: used.s.r, c: used.s.c },
        e: { r: Math.min(used.e.r, used.s.r + maxRows - 1), c: Math.min(used.e.c, used.s.c + maxCols - 1) },
      };
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true, range });
      return {
        name,
        rows,
        startRow: used.s.r,
        startCol: used.s.c,
        totalRows,
        totalCols,
        truncated: totalRows > maxRows || totalCols > maxCols,
      };
    });
    self.postMessage({ ok: true, sheets, totalSheets: names.length, sheetsTruncated: names.length > maxSheets });
  } catch (error) {
    self.postMessage({ ok: false, error: String((error && error.message) || error || 'Could not parse workbook') });
  }
};
