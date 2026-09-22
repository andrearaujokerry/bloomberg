/**
 * `providers/html.ts` against the recorded captures — WP-05, QA-05.
 *
 * Three real pages, each read through the replay store: the Wikipedia constituent table
 * (`wiki.sp500`, the only keyless source of GICS sector names), the FRED calendar and catalogue
 * (`fred.calendar`), and the BLS release schedule (`bls.schedule`, whose table is nested inside
 * another table). Pure: no socket, no database, no clock.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, readManifest } from '../../../src/providers/replayStore.js';
import {
  anchors,
  bodyRows,
  decodeHtmlEntities,
  documentTitle,
  extractTables,
  headerIndex,
  metaContent,
  normaliseSpace,
  rowRecords,
  stripTags,
  tableByClass,
  tableById,
  tableByHeaders,
} from '../../../src/providers/html.js';

const store = openReplayStore();
const manifest = readManifest('../../fixtures/providers');

function captureText(file: string): string {
  const wanted = `raw/${file}`;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.captures.some((c) => c.file === wanted)) continue;
    const record = store.lookup(key);
    if (record !== null) return record.body.toString('utf8');
  }
  throw new Error(`no manifest entry for ${wanted}`);
}

describe('entities and whitespace', () => {
  it('decodes named, numeric and hex references and leaves unknown ones alone', () => {
    expect(decodeHtmlEntities('AT&amp;T &nbsp;&ndash;&nbsp; 3M&#174; &#x2019;s &bogus;')).toBe(
      'AT&T \u00a0–\u00a0 3M® ’s &bogus;',
    );
  });

  it('collapses NBSP and whitespace runs the way every parse rule assumes', () => {
    expect(normaliseSpace('  a\u00a0 b\n\t c  ')).toBe('a b c');
  });

  it('strips tags without gluing words together', () => {
    expect(stripTags('<p>Consumer <b>Price</b> Index</p><p>August 2026</p>')).toBe(
      'Consumer Price Index August 2026',
    );
  });
});

describe('wiki-sp500.html (wiki.sp500, 556 KB)', () => {
  const html = captureText('wiki-sp500.html');
  const result = extractTables(html);

  it('finds the constituents table by id among the page’s many tables', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tables.length).toBeGreaterThan(1);

    const table = tableById(result.tables, 'constituents');
    expect(table).not.toBeNull();
    if (table === null) return;
    expect(table.classes).toContain('wikitable');
    // 1 header row + 503 constituents.
    expect(table.rows.length).toBe(504);
  });

  it('binds columns by header text and reads the first and last constituents', () => {
    if (!result.ok) throw new Error('extract failed');
    const table = tableById(result.tables, 'constituents');
    if (table === null) throw new Error('no constituents table');

    const index = headerIndex(table);
    expect(index).not.toBeNull();
    if (index === null) return;
    expect([...index.keys()]).toEqual([
      'symbol',
      'security',
      'gics sector',
      'gics sub-industry',
      'headquarters location',
      'date added',
      'cik',
      'founded',
    ]);

    const rows = bodyRows(table);
    expect(rows.length).toBe(503);

    const records = rowRecords(table);
    expect(records[0]).toMatchObject({
      symbol: 'MMM',
      security: '3M',
      'gics sector': 'Industrials',
      'gics sub-industry': 'Industrial Conglomerates',
      'headquarters location': 'Saint Paul, Minnesota',
      'date added': '1957-03-04',
      cik: '0000066740',
      founded: '1902',
    });
    expect(records[records.length - 1]).toMatchObject({
      symbol: 'ZTS',
      security: 'Zoetis',
      'gics sector': 'Health Care',
      cik: '0001555280',
    });

    // Every row has a non-empty symbol and one of the eleven GICS sector names.
    const sectors = new Set(records.map((r) => r['gics sector'] ?? ''));
    expect(sectors.size).toBe(11);
    expect(records.every((r) => (r.symbol ?? '').length > 0)).toBe(true);
    expect(records.every((r) => /^\d{10}$/.test(r.cik ?? ''))).toBe(true);
  });

  it('keeps a cell’s links, and an attribute value containing quotes and braces', () => {
    if (!result.ok) throw new Error('extract failed');
    const table = tableById(result.tables, 'constituents');
    if (table === null) throw new Error('no constituents table');
    const first = bodyRows(table)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const symbolCell = first.cells[0];
    expect(symbolCell?.text).toBe('MMM');
    expect(symbolCell?.links[0]?.href).toBe('https://www.nyse.com/quote/XNYS:MMM');
    // `data-mw='{"parts":[…]}'` — a single-quoted value full of double quotes and braces. Reading
    // it as an attribute (rather than scanning for the next '>') is what keeps the row intact.
    expect(symbolCell?.attrs.id).toBe('mwLg');
    expect(first.cells[1]?.links[0]?.href).toBe('https://en.wikipedia.org/wiki/3M');
  });
});

describe('fred-cal and fred-releases.html (fred.calendar)', () => {
  const calendar = captureText('fred-cal');
  const releases = captureText('fred-releases.html');

  it('reads the <meta name="description"> row-count invariant (PROVIDERS §10.2)', () => {
    const description = metaContent(calendar, 'description');
    expect(description).toBe(
      '34 economic release dates. FRED: Download, graph, and track economic data.',
    );
    const expected = Number(/^(\d+) economic release dates/.exec(description ?? '')?.[1] ?? '0');
    expect(expected).toBe(34);

    // …and the page really does carry that many release links, which is the check the invariant
    // exists to make possible.
    const rids = anchors(calendar)
      .map((a) => /\/release\?rid=(\d+)$/.exec(a.href)?.[1])
      .filter((rid): rid is string => rid !== undefined);
    expect(rids.length).toBe(expected);
  });

  it('groups the calendar rows under their date headings', () => {
    const result = extractTables(calendar);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const table = result.tables.find((t) => t.classes.includes('table-condensed'));
    expect(table).toBeDefined();
    if (table === undefined) return;

    let heading = '';
    const events: { day: string; time: string; rid: string; name: string }[] = [];
    for (const row of table.rows) {
      const first = row.cells[0];
      if (first === undefined) continue;
      // A date heading is a single cell spanning the table.
      if (row.cells.length === 1 && first.colspan >= 2) {
        heading = first.text.replace(/\s*Updated$/, '');
        continue;
      }
      const link = row.cells[1]?.links[0];
      const rid = link === undefined ? undefined : /\/release\?rid=(\d+)$/.exec(link.href)?.[1];
      if (rid === undefined) continue;
      events.push({ day: heading, time: first.text, rid, name: link?.text ?? '' });
    }

    expect(events.length).toBe(34);
    expect(events[0]).toEqual({
      day: 'Tuesday September 15, 2026',
      time: '1:00 am',
      rid: '502',
      name: 'Euro Short Term Rate',
    });
    // FRED publishes no time for some rows; the cell is empty, never a guessed 08:30.
    expect(events.some((e) => e.time === '')).toBe(true);
    expect(events.every((e) => e.day !== '')).toBe(true);
  });

  it('reads the 50 releases of the catalogue page, each with its rid', () => {
    const result = extractTables(releases);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = result.tables.flatMap((t) => t.rows);
    const items = rows
      .flatMap((r) => r.cells)
      .filter((c) => c.attrs.class === 'fred-releases-item')
      .map((c) => ({
        rid: /\/release\?rid=(\d+)$/.exec(c.links[0]?.href ?? '')?.[1] ?? '',
        name: c.text,
      }));

    expect(items.length).toBe(50);
    expect(items[0]).toEqual({ rid: '489', name: 'AD&Co US Mortgage High Yield Index' });
    expect(items[1]).toEqual({ rid: '194', name: 'ADP National Employment Report' });
    expect(new Set(items.map((i) => i.rid)).size).toBe(50);
  });
});

describe('bls-schedule.html (bls.schedule, a table nested inside a table)', () => {
  const html = captureText('bls-schedule.html');

  it('asserts the page title names the month, as §10.6 requires', () => {
    expect(documentTitle(html)).toBe('Schedule of Selected Releases for September 2026');
  });

  it('reads the release calendar, not the layout table that contains it', () => {
    const result = extractTables(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tables.length).toBe(2);

    const layout = tableById(result.tables, 'main-content-table');
    const calendar = tableByClass(result.tables, 'release-calendar');
    expect(layout).not.toBeNull();
    expect(calendar).not.toBeNull();
    if (calendar === null || layout === null) return;

    // The nested table's rows belong to it, never to the cell of the outer table.
    expect(calendar.depth).toBe(1);
    expect(layout.depth).toBe(0);
    expect(headerIndex(calendar)).not.toBeNull();
    expect([...(headerIndex(calendar) ?? new Map()).keys()]).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
    ]);
    expect(calendar.rows.length).toBe(6); // header + five weeks
    expect(bodyRows(calendar).length).toBe(5);
  });

  it('splits a day cell into its day number, release name, period and time', () => {
    const result = extractTables(html);
    if (!result.ok) throw new Error('extract failed');
    const calendar = tableByClass(result.tables, 'release-calendar');
    if (calendar === null) throw new Error('no release calendar');

    const cells = bodyRows(calendar).flatMap((r) => r.cells);
    expect(cells.length).toBe(25); // five weeks × five weekdays

    const cpiDay = cells.find((c) => c.attrs.id === 'd0911');
    expect(cpiDay).toBeDefined();
    if (cpiDay === undefined) return;
    // `<p class="day">11</p><p><strong>Consumer Price Index<br></strong>August 2026<br>08:30 AM</p>…`
    expect(cpiDay.lines).toEqual([
      '11',
      'Consumer Price Index',
      'August 2026',
      '08:30 AM',
      'Real Earnings',
      'August 2026',
      '08:30 AM',
    ]);

    // A holiday cell is marked by its class, and an empty day is an &nbsp; that collapses away.
    const labourDay = cells.find((c) => c.attrs.class === 'holiday');
    expect(labourDay?.lines).toEqual(['7', 'Labor Day', 'Holiday']);
    const emptyDay = cells.find((c) => c.attrs.id === 'd0908');
    expect(emptyDay?.lines).toEqual(['8']);

    // Every scheduled time is an ET clock time; no row invents one.
    const times = cells.flatMap((c) => c.lines).filter((l) => /^\d{2}:\d{2} (AM|PM)$/.test(l));
    expect(times.length).toBe(16);
  });
});

describe('robustness — QA-05: never throws on truncated, reordered or corrupted input', () => {
  const pages = [captureText('bls-schedule.html'), captureText('fred-cal')];

  it('never throws on 400 truncations of two real pages', () => {
    for (const page of pages) {
      for (let cut = 0; cut < 200; cut += 1) {
        const result = extractTables(page.slice(0, Math.floor((page.length * cut) / 200)));
        expect(result.ok).toBe(true);
      }
    }
  });

  it('never throws on deterministically scrambled markup', () => {
    let state = 987_654;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    const base = (pages[1] ?? '').slice(0, 20_000);
    for (let trial = 0; trial < 300; trial += 1) {
      const chars = [...base];
      const edits = 1 + Math.floor(next() * 16);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(next() * chars.length);
        const mode = Math.floor(next() * 3);
        if (mode === 0) chars.splice(at, 1);
        else if (mode === 1) chars.splice(at, 0, '<>="\'/ \n'[Math.floor(next() * 8)] ?? '<');
        else {
          const other = Math.floor(next() * chars.length);
          const a = chars[at];
          const b = chars[other];
          if (a !== undefined && b !== undefined) {
            chars[at] = b;
            chars[other] = a;
          }
        }
      }
      const result = extractTables(chars.join(''));
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('recovers an unclosed cell, an implied row and a cell outside a row', () => {
    const result = extractTables('<table><tr><td>a<td>b</table><table><td>c</td></table>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tables[0]?.rows[0]?.cells.map((c) => c.text)).toEqual(['a', 'b']);
    expect(result.tables[1]?.rows[0]?.cells.map((c) => c.text)).toEqual(['c']);
    expect(result.problems.some((p) => p.detail.includes('outside a <tr>'))).toBe(true);
  });

  it('reports an unclosed table rather than losing its rows', () => {
    const result = extractTables('<table><tr><td>a</td></tr>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tables.length).toBe(1);
    expect(result.tables[0]?.rows[0]?.cells[0]?.text).toBe('a');
    expect(result.problems.some((p) => p.detail.includes('never closed'))).toBe(true);
  });

  it('never reads a table out of a <script> block', () => {
    const result = extractTables(
      '<script>var s = "<table><tr><td>fake</td></tr></table>";</script><table><tr><td>real</td></tr></table>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tables.length).toBe(1);
    expect(result.tables[0]?.rows[0]?.cells[0]?.text).toBe('real');
  });

  it('finds a table by its header text when it has neither id nor class', () => {
    const result = extractTables(
      '<table><tr><th>Symbol</th><th>Weight</th></tr><tr><td>AAPL</td><td>7.4</td></tr></table>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = tableByHeaders(result.tables, ['symbol', 'weight']);
    expect(table).not.toBeNull();
    expect(tableByHeaders(result.tables, ['symbol', 'sedol'])).toBeNull();
    expect(rowRecords(table ?? result.tables[0]!)).toEqual([{ symbol: 'AAPL', weight: '7.4' }]);
  });
});
