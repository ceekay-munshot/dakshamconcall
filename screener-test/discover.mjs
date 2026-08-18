/**
 * discover.mjs — find companies that have just held an earnings call.
 * ===================================================================
 * The client's ask: "वी वांट इट टू हैपन बाय इटसेल्फ ... कॉन कॉल्स आते रहे और ये
 * अपडेट होते रहे" — the board should fill itself as concalls happen, with no
 * manual adding, across ALL listed companies rather than a curated list.
 *
 * Screener has no public "recent concalls" feed (/concalls/ redirects to signup),
 * and polling thousands of company pages daily is not viable. So we use the
 * client's own proxy: "ए समरी का प्रॉक्सी रिकॉर्डिंग होता है" — a company files
 * its call recording / transcript with the exchange, and Screener's AI summary
 * appears the same day. BSE publishes those filings in a public announcements
 * feed, which is where this module looks.
 *
 * Pure and testable: the HTTP call is injectable, and the parsing/filtering is
 * separated from it.
 */

const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

/** Announcement sub-categories that mean "an earnings call just happened". */
const CONCALL_SUBCATS = new Set(["Earnings Call Transcript", "Analyst / Investor Meet"]);

/** Fallback for rows whose sub-category is vague ("General") but whose headline
 *  clearly describes a call. Deliberately narrow to avoid false positives. */
const CONCALL_TEXT =
  /\b(earnings|analyst|investor|conference)\s+call\b|\bcon\s?call\b|\btranscript of\b|\baudio recording\b|\btranscripts? of (the )?(investor|analyst|earnings)\b/i;

const yyyymmdd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

/**
 * Is this announcement an earnings-call filing?
 * @param {object} row a BSE announcement row
 */
export function isConcallFiling(row) {
  if (!row) return false;
  const sub = (row.SUBCATNAME || "").trim();
  if (CONCALL_SUBCATS.has(sub)) return true;
  // A recording attached to an investor-meet row is the strongest signal of all.
  if (row.AUDIO_VIDEO_FILE && String(row.AUDIO_VIDEO_FILE).trim()) return true;
  return CONCALL_TEXT.test(`${row.HEADLINE || ""} ${row.NEWSSUB || ""}`);
}

/** Normalize a BSE row into a discovery candidate. */
export function toCandidate(row) {
  const name = (row.SLONGNAME || "").trim();
  if (!name) return null;
  return {
    name,
    scrip: String(row.SCRIP_CD || "").trim() || null,
    // NEWS_DT is the filing timestamp; the call itself may be a day or two earlier.
    filed_at: (row.NEWS_DT || row.DT_TM || "").slice(0, 10) || null,
    subcat: (row.SUBCATNAME || "").trim() || null,
  };
}

/**
 * Turn a raw BSE payload into de-duplicated candidates (newest filing wins).
 * Kept separate from the fetch so it can be tested without a network.
 */
export function candidatesFrom(payload) {
  const rows = payload?.Table || payload?.table || [];
  const byName = new Map();
  for (const row of rows) {
    if (!isConcallFiling(row)) continue;
    const c = toCandidate(row);
    if (!c) continue;
    const prev = byName.get(c.name);
    if (!prev || String(c.filed_at) > String(prev.filed_at)) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => String(b.filed_at).localeCompare(String(a.filed_at)));
}

/**
 * Fetch concall filings from BSE for the last `days` days.
 * @param {{days?:number, fetchImpl?:Function, now?:Date}} opts
 * @returns {Promise<Array<{name:string,scrip:string|null,filed_at:string|null,subcat:string|null}>>}
 */
export async function discoverConcalls(opts = {}) {
  const days = opts.days ?? 2;
  const maxPages = Math.max(1, opts.maxPages ?? 1);
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || new Date();
  const from = new Date(now.getTime() - days * 86400000);

  // BSE paginates the announcements feed via `pageno` (newest first). The nightly
  // run reads a 2-day window, where page 1 is enough. A backfill run widens `days`
  // to cover the quarter and pages deeper (maxPages) to reach the older filings —
  // page 1 alone only ever returns the most recent rows in the window.
  const rows = [];
  for (let pageno = 1; pageno <= maxPages; pageno++) {
    const url =
      `${BSE_API}?pageno=${pageno}&strCat=Company%20Update&strPrevDate=${yyyymmdd(from)}` +
      `&strScrip=&strSearch=P&strToDate=${yyyymmdd(now)}&strType=C&subcategory=-1`;

    const res = await doFetch(url, {
      headers: {
        // BSE's API rejects requests that don't look like the site's own XHR.
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.bseindia.com/",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`BSE announcements ${res.status}`);
    const payload = await res.json();
    const pageRows = payload?.Table || payload?.table || [];
    if (!pageRows.length) break; // past the last page in the window
    rows.push(...pageRows);
  }
  return candidatesFrom({ Table: rows });
}

/* ============================================================================
   Daily queue.
   Transcript-first removed Screener's 80/day summary cap, so the limit is now
   wall-clock throughput, not metered views. The board processes up to `cap`
   companies per run (default 40); everything discovered beyond that rolls forward
   instead of being dropped, so a wide backfill drains over a few runs.
   ========================================================================== */

/**
 * Decide today's work list and what rolls over.
 * @param {object} state   previous queue state { date, pending: string[], processed: number }
 * @param {string[]} discovered  tickers/names found today
 * @param {string} today   YYYY-MM-DD
 * @param {number} cap     max companies to process today
 * @returns {{today: string[], pending: string[], stats: object}}
 */
export function planDay(state, discovered, today, cap = 20) {
  const prevPending = state?.date === today ? state.pending || [] : state?.pending || [];
  const alreadyToday = state?.date === today ? state.processed || 0 : 0;

  // Yesterday's leftovers go first — otherwise a busy day could starve them forever.
  const seen = new Set();
  const queue = [];
  for (const t of [...prevPending, ...discovered]) {
    const k = String(t || "").toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    queue.push(k);
  }

  const room = Math.max(0, cap - alreadyToday);
  const todayList = queue.slice(0, room);
  const pending = queue.slice(room);
  return {
    today: todayList,
    pending,
    stats: {
      date: today,
      discovered: discovered.length,
      carried_over: prevPending.length,
      queued_total: queue.length,
      processing_today: todayList.length,
      pending_tomorrow: pending.length,
      cap,
      already_processed_today: alreadyToday,
    },
  };
}
