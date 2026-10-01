import { Platform } from 'react-native';

/**
 * Turning a table on screen into a file an accountant can open.
 *
 * ⚠ Three things make a CSV writer non-trivial, and all three have bitten
 *   somebody in production before.
 *
 *   1. **Quoting.** A Nigerian address contains commas; a cancellation reason
 *      contains quotes and newlines. RFC 4180 says wrap the field in quotes and
 *      double any quote inside it. A writer that only escapes commas produces a
 *      file that opens with the columns silently shifted from one row onwards,
 *      and the person reconciling it sees amounts against the wrong references.
 *
 *   2. **Formula injection.** A field beginning `=`, `+`, `-` or `@` is
 *      executed by Excel, Sheets and Numbers when the file is opened. Our
 *      fields are mostly machine-generated, but `full_name` and a payout's
 *      `reference` are typed by people, and a reference of `=1+1` is enough to
 *      demonstrate it. Prefixing a tab is the standard defusal: the cell reads
 *      as text and looks unchanged.
 *
 *   3. **The BOM.** Excel on Windows reads a CSV as the system codepage unless
 *      the file opens with a UTF-8 byte-order mark, so `₦` arrives as `â‚¦`.
 *      Three bytes at the front is the whole fix.
 */

export type CsvColumn<Row> = {
  /** The header cell, exactly as it should appear. */
  header: string;
  /** One cell. Return a number for a numeric column — see `cell` below. */
  value: (row: Row) => string | number | null | undefined;
};

/**
 * ⚠ Numbers are written bare, everything else is quoted.
 *
 *   A quoted number is still a number to every spreadsheet worth naming, but
 *   writing it bare means a column of amounts arrives already right-aligned and
 *   summable without a "convert to number" step. Currency symbols and thousand
 *   separators are deliberately absent for the same reason: `₦2,800.00` is
 *   text, and a column of text does not add up.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  const text = String(value);

  /* See 2 above. The tab is stripped by the spreadsheet on display. */
  const defused = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;

  return `"${defused.replace(/"/g, '""')}"`;
}

export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const header = columns.map((column) => cell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => cell(column.value(row))).join(','));

  /*
   * CRLF, because RFC 4180 says so and because Excel on Windows treats a
   * lone LF in a quoted field and a lone LF as a row terminator identically —
   * which is how a multi-line address becomes three broken rows.
   */
  return [header, ...body].join('\r\n');
}

/** A filename nobody has to rename: what it is, and when it was taken. */
export function csvFilename(prefix: string, from?: Date | null, to?: Date | null): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const span = from && to ? `_${day(from)}_to_${day(to)}` : `_${day(new Date())}`;
  return `pkrelay_${prefix}${span}.csv`;
}

export type DownloadResult = { ok: true } | { ok: false; reason: string };

/**
 * Hands the file to the browser.
 *
 * ⚠ Web only, and it says so rather than pretending.
 *
 *   Saving a file on a phone needs a share sheet — `expo-sharing`, which this
 *   project does not install — and writing one to `cacheDirectory` where
 *   nothing can open it is worse than not offering the button: it reports
 *   success and produces nothing. The admin console is a desktop tool; the
 *   export is a desktop feature; the native build says one sentence explaining
 *   that instead of failing quietly.
 *
 * ⚠ The object URL is revoked, and on a timer rather than immediately.
 *
 *   Revoking in the same tick as the click cancels the download in Safari,
 *   which has not started reading the blob yet. Never revoking leaks the whole
 *   file for the life of the tab, and these exports are not small.
 */
export function downloadCsv(filename: string, csv: string): DownloadResult {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    return {
      ok: false,
      reason: 'CSV export works in the web console. Open Package Relay in a browser to export.',
    };
  }

  try {
    /* ﻿ — see 3 above. */
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    setTimeout(() => URL.revokeObjectURL(url), 30_000);

    return { ok: true };
  } catch (thrown) {
    return { ok: false, reason: `The browser refused the download: ${String(thrown)}` };
  }
}
