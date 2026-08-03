/**
 * analyze-company.mjs — orchestrator for the Daksham analysis engine.
 * ===================================================================
 * Take a TICKER (env TICKER) — or loop over tracked.json when TICKER is empty
 * (refresh mode) — and for each company:
 *   1. mark jobs.json[TICKER] = running and commit EARLY (UI shows Processing),
 *   2. scrape Screener's latest concall summary (transcript fallback),
 *   3. classify it (+ up to 3 prior quarters) into the fixed 11-section schema,
 *      finalizing guidance-vs-delivery statuses deterministically,
 *   4. write the tear sheet into public/data/*.json and commit the result.
 *
 * Per-company errors are captured into jobs.json (friendly "failed" state) —
 * one bad company never crashes the whole run. Commits use a re-apply-on-reject
 * push loop so concurrent runs never clobber each other's JSON.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import { launchAndLogin, scrapeCompany, resolveTicker } from "./scrape-screener.mjs";
import { discoverConcalls, planDay } from "./discover.mjs";
import { classifyQuarter, diffGuidance, diffRisks, editTearSheet } from "./classify.mjs";
import { activeModel, llmBanner } from "./llm.mjs";

const DIR = "public/data";
const FILES = {
  tracked: `${DIR}/tracked.json`,
  tearsheets: `${DIR}/tearsheets.json`,
  jobs: `${DIR}/jobs.json`,
  metadata: `${DIR}/metadata.json`,
  queue: `${DIR}/queue.json`,
};
// Commit to the branch this workflow runs on (main in production; the feature
// branch during testing). GITHUB_REF_NAME is set by Actions.
const BRANCH = process.env.TARGET_BRANCH || process.env.GITHUB_REF_NAME || "main";
const STALE_DAYS = 80;
const REFRESH_THROTTLE_DAYS = 3; // don't re-scrape a stale name more often than this
// How many quarters we STORE per company. Kept at 4 so history already paid for
// is never trimmed away — we simply stop fetching more (see FETCH_QUARTERS).
const MAX_QUARTERS = 4;
// How many quarters a NEW fetch covers: the latest call plus one previous, both
// from the AI summary. Client's call — 20 companies x 2 = 40 summaries/day, half
// of Screener's 80/day cap, and the previous quarter gives the rate-of-change
// context. Anything older we already hold stays untouched.
const FETCH_QUARTERS = 2;
// Bump when a pipeline change should force stored quarters to be rebuilt.
// Quarters stamped with the current version are reused instead of re-classified.
const PIPELINE_VERSION = 3;
// Screener allows 80 AI summaries/day and we spend 2 per company, so the client
// capped the board at 20 companies/day; the rest rolls to the next day.
const DAILY_COMPANY_CAP = parseInt(process.env.DAILY_COMPANY_CAP || "", 10) || 20;
// How far back the announcements feed is read (covers a weekend / a late filing).
const DISCOVER_DAYS = parseInt(process.env.DISCOVER_DAYS || "", 10) || 2;
// How many days a company that produced nothing keeps being re-checked. Screener
// publishes a call's summary or transcript some days after the call, so "nothing
// there yet" is usually a matter of timing — but a ticker that genuinely never
// files must not be retried forever, hence the ceiling.
const RETRY_DAYS = parseInt(process.env.RETRY_DAYS || "", 10) || 5;
// Re-classify quarters we already hold instead of reusing them. Off by default —
// reuse is what stopped the pipeline re-spending on 77 unchanged quarters. Turn it
// on to compare two models or two prompts on the SAME source: without it a re-run
// reuses the stored answer and measures nothing. Run it on a branch, since it
// spends Screener views and overwrites the quarters it rebuilds.
const FORCE_REBUILD = process.env.FORCE_REBUILD === "1";

const log = (...a) => console.log("[analyze]", ...a);

/* ---- JSON store helpers ---- */
const readJson = (f, fallback) => {
  if (!fs.existsSync(f)) return fallback; // genuinely absent (e.g. first run) -> safe default
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    // The file EXISTS but won't parse. Do NOT fall back to an empty store — that
    // would drop every other company on the next write. Abort loudly instead, so
    // the last good committed data is left completely untouched.
    throw new Error(`refusing to overwrite ${f}: it exists but is not valid JSON (${e.message})`);
  }
};
// Atomic write: serialize to a temp file, then rename it over the target. rename
// is atomic on the same filesystem, so a process killed mid-write can never leave
// a half-written (corrupt) store behind — the file is always the whole old or the
// whole new version, never a partial one.
const writeJson = (f, obj) => {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, f);
};

function loadStores() {
  return {
    tracked: readJson(FILES.tracked, { companies: [], updated_at: null }),
    tearsheets: readJson(FILES.tearsheets, { companies: {} }),
    jobs: readJson(FILES.jobs, { jobs: {} }),
    metadata: readJson(FILES.metadata, { updated_at: null, count: 0 }),
    queue: readJson(FILES.queue, { date: null, pending: [], processed: 0, stats: null }),
  };
}

/* Pending mutations — re-applied onto the latest base on every persist so a
   push rejection can be resolved by rebasing our LOGICAL changes, never text. */
const pending = {
  queue: null, // discovery queue + counters for the dashboard
  jobs: new Map(), // ticker -> job entry
  tearsheets: new Map(), // ticker -> { company, ticker, industry, country, quarters:[...] }
  tracked: new Map(), // ticker -> partial tracked entry
};

const nowIso = () => new Date().toISOString();

function applyPending(stores) {
  // jobs
  for (const [t, entry] of pending.jobs) stores.jobs.jobs[t] = entry;

  // tearsheets (merge quarters with whatever base already has)
  for (const [t, comp] of pending.tearsheets) {
    const base = stores.tearsheets.companies[t];
    const merged = mergeQuarters(base?.quarters || [], comp.quarters);
    stores.tearsheets.companies[t] = { ...base, ...comp, quarters: merged };
  }

  // tracked (upsert + sync fields)
  for (const [t, patch] of pending.tracked) {
    const arr = stores.tracked.companies;
    const idx = arr.findIndex((c) => (c.ticker || "").toUpperCase() === t);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
    else arr.push({ ticker: t, added_at: nowIso(), ...patch });
  }
  if (pending.tracked.size) stores.tracked.updated_at = nowIso();

  // discovery queue (whole-object replace — it is a single small record)
  if (pending.queue) stores.queue = pending.queue;

  // metadata: count = companies that have a tear sheet
  stores.metadata.count = Object.keys(stores.tearsheets.companies).length;
  stores.metadata.updated_at = nowIso();
}

function mergeQuarters(baseQuarters, newQuarters) {
  // Dedup by MONTH (one earnings call per quarter), so a newly precise call date
  // (e.g. 2026-07-17) doesn't sit alongside its own older month-level record
  // (2026-07-01) as a duplicate quarter. When both exist for a month, keep the
  // one with the precise (non "-01") day. New (freshly-scraped) quarters win ties.
  const byMonth = new Map();
  const monthKey = (q) => (q.concall_date || q.generated_at || "").slice(0, 7) || Math.random().toString();
  const day = (q) => +String(q.concall_date || "").slice(8, 10) || 1;
  // The client's source of record is the Screener AI SUMMARY; a transcript is only
  // a fallback for when the summary can't be read (e.g. Screener's 80/day cap).
  // So never let a transcript re-run REPLACE a stored ai_summary quarter for the
  // same call — that would quietly downgrade the tear sheet for a temporary reason.
  const isSummary = (q) => q?.source === "ai_summary";
  for (const q of [...newQuarters, ...baseQuarters]) {
    const key = monthKey(q);
    const cur = byMonth.get(key);
    if (!cur) byMonth.set(key, q);
    else if (isSummary(cur) !== isSummary(q)) {
      if (isSummary(q)) byMonth.set(key, q); // summary always beats transcript
    } else if (day(q) > 1 && day(cur) === 1) byMonth.set(key, q); // upgrade to the precise-dated record
  }
  return [...byMonth.values()]
    .sort((a, b) => String(b.concall_date || "").localeCompare(String(a.concall_date || "")))
    .slice(0, MAX_QUARTERS);
}

/* ---- git commit + push with re-apply-on-reject ---- */
function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString().trim();
}
function hasStaged() {
  try {
    execSync("git diff --cached --quiet");
    return false; // nothing staged
  } catch {
    return true;
  }
}

// A run outside CI is a developer running the script by hand. BRANCH defaults to
// "main", so without this a local smoke test commits and pushes real job state
// onto the live dashboard — which is exactly what happened once. CI sets
// GITHUB_ACTIONS; ALLOW_LOCAL_WRITE=1 is the deliberate override.
const DRY_RUN = !process.env.GITHUB_ACTIONS && process.env.ALLOW_LOCAL_WRITE !== "1";

function persistAndPush(message) {
  if (DRY_RUN) {
    log(`[dry-run] would commit "${message}" (set ALLOW_LOCAL_WRITE=1 to really write)`);
    return false;
  }
  // Re-apply our LOGICAL mutations onto whatever is currently on disk, then
  // commit. Returns false when there's nothing new to commit.
  const commitOnce = () => {
    const stores = loadStores();
    applyPending(stores);
    writeStores(stores);
    sh(`git add ${Object.values(FILES).join(" ")}`);
    if (!hasStaged()) return false;
    sh(`git commit -m ${JSON.stringify(message)}`);
    return true;
  };

  if (!commitOnce()) {
    log("nothing to commit");
    return false;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      sh(`git push origin HEAD:${BRANCH}`);
      log("pushed:", message);
      return true;
    } catch {
      // Someone else pushed first. Reset to their tip and re-apply our changes
      // onto it (no textual conflicts possible — we rebuild from pending state).
      log(`push rejected (attempt ${attempt + 1}); rebasing onto latest ${BRANCH}`);
      try {
        sh(`git fetch origin ${BRANCH}`);
        sh(`git reset --hard origin/${BRANCH}`);
      } catch (e) {
        log("fetch/reset warning:", e.message);
      }
      if (!commitOnce()) return true; // origin already reflects our intent
    }
  }
  throw new Error(`push failed after retries for: ${message}`);
}

function writeStores(stores) {
  writeJson(FILES.tracked, stores.tracked);
  writeJson(FILES.tearsheets, stores.tearsheets);
  writeJson(FILES.jobs, stores.jobs);
  writeJson(FILES.metadata, stores.metadata);
  writeJson(FILES.queue, stores.queue);
}

/* ---- helpers ---- */
function topGuidanceHeadline(ledger = []) {
  const specific = ledger.find((g) => g.specificity === "specific");
  return (specific || ledger[0])?.statement || null;
}

/* ============================================================================
   Current reporting cycle.
   The dashboard is FORWARD-RUNNING: it shows companies that have reported the
   most recent round of calls, and rolls on by itself (nothing is hardcoded to
   "Q1"). The cycle is derived from the newest call in the universe, so when the
   next quarter's calls start landing the whole board moves with them.

   GRACE PERIOD: a straggler is only hidden once the new cycle is genuinely
   underway (CYCLE_QUORUM companies in it). Without that, the first company to
   report a new quarter would instantly hide everyone else and the dashboard
   would sit near-empty for the fortnight until the rest report.
   ========================================================================== */
const CYCLE_QUORUM = 3;

/** Calendar quarter key for a call date, e.g. "2026-07-01" -> "2026Q3". */
export function cycleKey(iso) {
  if (!iso) return null;
  const y = +String(iso).slice(0, 4), m = +String(iso).slice(5, 7);
  if (!y || !m) return null;
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}

/**
 * The cycle the board is currently on, or null while the newest cycle is still
 * too thin to switch to (grace period). Pure — exported for tests.
 */
export function currentCycle(companies, quorum = CYCLE_QUORUM) {
  const counts = new Map();
  for (const c of Object.values(companies || {})) {
    const k = cycleKey(c?.quarters?.[0]?.concall_date);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return null;
  const keys = [...counts.keys()].sort().reverse(); // newest first
  // Walk back from the newest cycle to the first one with enough reporters.
  for (const k of keys) if (counts.get(k) >= quorum) return k;
  return null; // nothing has quorum yet -> hide nobody
}

/** Has this company reported the current cycle? Unknown cycle -> treat as yes. */
export function isCurrent(comp, cycle) {
  if (!cycle) return true;
  return cycleKey(comp?.quarters?.[0]?.concall_date) === cycle;
}

function isStale(store, ticker) {
  const comp = store.tearsheets.companies[ticker];
  const latest = comp?.quarters?.[0];
  if (!latest?.concall_date) return true; // never analyzed
  const ageDays = (Date.now() - new Date(latest.concall_date).getTime()) / 86400000;
  if (ageDays <= STALE_DAYS) return false; // latest quarter still fresh

  // Stale by quarter age — but throttle so we don't re-scrape + re-classify the
  // same company daily while Screener has no newer call (avoids API cost/churn).
  const checked = comp?.checked_at ? new Date(comp.checked_at).getTime() : 0;
  const checkedDaysAgo = (Date.now() - checked) / 86400000;
  return checkedDaysAgo > REFRESH_THROTTLE_DAYS;
}

/* ============================================================================
   Per-company flow
   ========================================================================== */
async function analyzeTicker(page, context, ticker, baseStore) {
  const T = ticker.toUpperCase();
  log(`=== ${T} ===`);

  // 1) mark running + commit early so the UI flips to Processing.
  pending.jobs.set(T, { status: "running", started_at: nowIso() });
  persistAndPush(`analyze: ${T} running`);

  // 2) scrape
  // Only fetch the latest + one previous quarter, and skip any month we already
  // hold as an ai_summary — that is what keeps us inside Screener's 80/day cap.
  const storedQuarters = baseStore.tearsheets.companies[T]?.quarters || [];
  const haveSummaryMonths = storedQuarters
    .filter((q) => q.source === "ai_summary" && q.concall_date)
    .map((q) => q.concall_date.slice(0, 7));
  // Months we already hold from a TRANSCRIPT. The summary is still fetched for
  // these (that is the upgrade attempt), but if no summary exists there is
  // nothing to gain from downloading and re-parsing the very same PDF: the
  // stored quarter is already the answer. Skipping it is the slowest step in
  // the run, not just the cheapest saving.
  const haveTranscriptMonths = storedQuarters
    .filter((q) => q.source === "transcript" && q.concall_date)
    .map((q) => q.concall_date.slice(0, 7));
  const scrapeOpts = { maxHistory: FETCH_QUARTERS, haveSummaryMonths, haveTranscriptMonths };
  const scrape = await scrapeCompany(page, context, T, scrapeOpts);

  // Forward-running board: if the company hasn't reported the cycle everyone else
  // is on, there is nothing new to show and no reason to spend a summary view.
  if (!scrape.error && scrape.concall_date && baseStore.__cycle) {
    if (cycleKey(scrape.concall_date) !== baseStore.__cycle) {
      log(`${T}: latest call ${scrape.concall_date} is behind the current cycle ${baseStore.__cycle} — skipping`);
      pending.jobs.set(T, {
        status: "failed",
        finished_at: nowIso(),
        error: "no_current_quarter",
        message: "Sorry, can't find Q1 on Screener. Please search for a different company.",
      });
      persistAndPush(`analyze: ${T} skipped (no current-quarter concall)`);
      return "failed";
    }
  }
  if (scrape.error) {
    // Screener's daily AI-summary cap (80/day) is TEMPORARY. Downgrading is now
    // prevented in mergeQuarters (a stored ai_summary quarter is never replaced by
    // a transcript one), so it is safe to CARRY ON and cover the company from its
    // transcript — coverage today, and the summary upgrade lands on a later run.
    // Set ON_RATE_LIMIT=stop to halt instead and leave the rest for tomorrow.
    if (scrape.rateLimited) {
      log(`${T}: Screener's daily AI-summary cap reached — using the transcript fallback for now.`);
      if ((process.env.ON_RATE_LIMIT || "").toLowerCase() === "stop") {
        pending.jobs.set(T, {
          status: "failed",
          finished_at: nowIso(),
          error: scrape.error,
          message: `Screener's daily AI-summary limit was reached, so ${T} was left unchanged. It resets daily — re-run tomorrow.`,
        });
        persistAndPush(`analyze: ${T} skipped (Screener daily limit)`);
        return "rate_limited";
      }
      // Re-scrape with the summary path disabled so it goes straight to the
      // transcript instead of burning another capped request.
      const viaTranscript = await scrapeCompany(page, context, T, { ...scrapeOpts, skipSummary: true });
      if (!viaTranscript.error) {
        Object.assign(scrape, viaTranscript, { error: undefined, rateLimited: false });
      }
    }
    if (scrape.error) {
      pending.jobs.set(T, {
        status: "failed",
        finished_at: nowIso(),
        error: scrape.error,
        // Say what is actually true and what happens next. "Couldn't fetch"
        // sounds like a broken scraper; the common case is that Screener has
        // simply not published this call yet, and the company is re-checked
        // automatically for the next few days (RETRY_DAYS).
        message: /could not extract an AI summary or transcript/i.test(scrape.error || "")
          ? `Screener has no AI summary and no transcript for ${T}'s latest concall yet. We'll keep checking — it appears here automatically once either is published.`
          : `Couldn't fetch ${T}'s latest concall. ${scrape.error}`,
      });
      persistAndPush(`analyze: ${T} failed`);
      return "failed";
    }
  }

  // Industry: the SCRAPER-captured value is authoritative; fall back to the
  // search-API industry passed via env (INDUSTRY) or stored in tracked.json.
  const trackedEntry = baseStore.tracked.companies.find(
    (c) => (c.ticker || "").toUpperCase() === T
  );
  const industry =
    scrape.industry || process.env.INDUSTRY || trackedEntry?.industry || null;
  const country = trackedEntry?.country ?? "India";
  log(`${T} industry -> ${industry || "(none)"}`);

  // 3) classify latest + history, oldest -> newest so guidance deltas compute.
  const chronological = [...(scrape.history || [])].reverse().concat([scrape]);
  const oldestScrapedDate = chronological.find((q) => q.concall_date)?.concall_date || null;

  // Seed deltas only from a STORED quarter strictly older than the first scraped
  // quarter (else we'd compute backwards raised/lowered against a newer quarter).
  const stored = baseStore.tearsheets.companies[T]?.quarters || [];
  const seed =
    stored
      .filter((qq) => qq.concall_date && oldestScrapedDate && qq.concall_date < oldestScrapedDate)
      .sort((a, b) => String(b.concall_date).localeCompare(String(a.concall_date)))[0] || null;
  let priorGuidance = seed?.guidance_ledger || null;
  let priorRisks = seed?.risk_register || null;
  let priorThemes = seed?.themes || null; // stable theme labels across quarters

  // Reuse a quarter we have already built rather than paying to rebuild it. A
  // past earnings call never changes, so re-classifying it is pure waste.
  //
  // Reuse used to require the stored source to be an ai_summary, so that a
  // transcript quarter kept its chance to upgrade. In practice that meant
  // re-classifying the transcript from scratch on EVERY run even when Screener
  // still had no summary — on a 25-company board, 85 of 86 quarters were being
  // rebuilt to produce the same answer. The upgrade attempt is what matters, not
  // the rebuild: re-classify only when the source actually got BETTER
  // (transcript -> ai_summary), and otherwise keep what we have.
  const sourceRank = (src) => (src === "ai_summary" ? 2 : 1);
  const storedByMonth = new Map(
    stored.filter((q) => q.concall_date).map((q) => [q.concall_date.slice(0, 7), q])
  );
  const classifiedNewestFirst = [];
  for (const q of chronological) {
    const prev = q.concall_date ? storedByMonth.get(q.concall_date.slice(0, 7)) : null;
    // PIPELINE_VERSION still forces a one-time rebuild when the pipeline itself
    // improves — that is a deliberate cost, paid once per quarter, not per run.
    const improved = prev && sourceRank(q.source) > sourceRank(prev.source);
    if (!FORCE_REBUILD && prev && !improved && prev.pipeline_version === PIPELINE_VERSION) {
      log(`reusing stored ${T} @ ${prev.concall_date} (unchanged — no LLM call)`);
      classifiedNewestFirst.unshift(prev);
      priorGuidance = prev.guidance_ledger || priorGuidance;
      priorRisks = prev.risk_register || priorRisks;
      if (Array.isArray(prev.themes) && prev.themes.length) priorThemes = prev.themes;
      continue;
    }
    // A `reused` marker means the scraper deliberately skipped re-reading a
    // source we already hold, so it carries no text. It should always have been
    // matched to a stored quarter above; if it was not — a month key that did
    // not line up, a store edited underneath us — classifying it would feed the
    // model an empty document. Keep whatever is stored and move on instead.
    if (q.reused) {
      log(`skipping ${T} @ ${q.concall_date || "?"} — nothing new to read and no stored quarter matched`);
      if (prev) classifiedNewestFirst.unshift(prev);
      continue;
    }
    log(`classifying ${T} @ ${q.concall_date || "?"} (${q.source})`);
    const c = await classifyQuarter(q, priorGuidance, priorThemes);
    c.guidance_ledger = diffGuidance(c.guidance_ledger, priorGuidance);
    c.risk_register = diffRisks(c.risk_register, priorRisks);
    priorGuidance = c.guidance_ledger;
    priorRisks = c.risk_register;
    if (Array.isArray(c.themes) && c.themes.length) priorThemes = c.themes;

    classifiedNewestFirst.unshift({
      company: scrape.company,
      ticker: T,
      industry,
      country,
      concall_date: q.concall_date,
      source: q.source,
      source_url: q.source_url,
      model: activeModel(),
      pipeline_version: PIPELINE_VERSION,
      generated_at: nowIso(),
      summary: c.summary,
      sections: c.sections,
      guidance_ledger: c.guidance_ledger,
      risk_register: c.risk_register,
      themes: Array.isArray(c.themes) ? c.themes : [],
      key_takeaways: c.key_takeaways,
      pressing_questions: c.pressing_questions,
    });
  }

  // Governing editor pass on the DISPLAYED (latest) quarter — curate the prose,
  // preserve every figure. Historical quarters only feed the numeric trend
  // matrix, so we pay for the editor once, on the quarter whose prose is shown.
  // editTearSheet is best-effort (returns the first-pass sections on any error).
  if (classifiedNewestFirst[0] && process.env.TEARSHEET_EDITOR !== "0") {
    classifiedNewestFirst[0].sections = await editTearSheet(classifiedNewestFirst[0].sections, {
      company: scrape.company,
      ticker: T,
    });
  }

  const latest = classifiedNewestFirst[0];

  // 4) stage tearsheet + tracked + job done
  pending.tearsheets.set(T, {
    company: scrape.company,
    ticker: T,
    industry,
    country,
    checked_at: nowIso(), // throttles the daily stale-refresh loop
    quarters: classifiedNewestFirst,
  });
  pending.tracked.set(T, {
    ticker: T,
    name: scrape.company,
    industry,
    country,
    concall_date: latest.concall_date,
    source: latest.source,
    guidance_headline: topGuidanceHeadline(latest.guidance_ledger),
  });
  pending.jobs.set(T, {
    status: "done",
    finished_at: nowIso(),
    concall_date: latest.concall_date,
    source: latest.source,
  });

  persistAndPush(`Analyze ${T} (${latest.concall_date || "latest"})`);
  log(`done ${T}: ${classifiedNewestFirst.length} quarter(s)`);
  return "added"; // a tear sheet reached the dashboard — the only outcome that counts
}

/* ============================================================================
   Main
   ========================================================================== */
async function main() {
  log(llmBanner()); // which LLM this run will use (no secrets)
  const single = (process.env.TICKER || "").trim().toUpperCase();
  const base = loadStores();
  // The reporting cycle the board is on (null while the newest one lacks quorum).
  let discoveryNames = [];
  base.__cycle = currentCycle(base.tearsheets.companies);
  if (base.__cycle) log(`current reporting cycle: ${base.__cycle}`);

  // MAX_PER_RUN caps BOTH the tracked slice and the delivery target, so a
  // deliberately small run stays small even when discovery adds candidates.
  const maxPerRun = parseInt(process.env.MAX_PER_RUN || "", 10);
  let tickers;
  if (single) {
    tickers = [single];
  } else {
    // Refresh mode (blank ticker). A MANUAL dispatch force-reprocesses EVERY
    // tracked company (so new pipeline logic is applied to all); the scheduled
    // daily run only touches STALE companies (keeps the cron cheap).
    const forceAll = (process.env.EVENT_NAME || "") === "workflow_dispatch";
    const all = (base.tracked.companies || [])
      .map((c) => (c.ticker || "").toUpperCase())
      .filter(Boolean);
    tickers = forceAll ? all : all.filter((t) => isStale(base, t));
    // Skip companies that haven't reported the current cycle — they have nothing
    // new, and each one would cost metered summary views to find that out.
    if (base.__cycle) {
      const before = tickers.length;
      tickers = tickers.filter((t) => {
        const comp = base.tearsheets.companies[t];
        return !comp || isCurrent(comp, base.__cycle);
      });
      if (before !== tickers.length)
        log(`skipping ${before - tickers.length} company(ies) behind cycle ${base.__cycle}`);
    }

    // MAX_PER_RUN paces a run against Screener's 80-summaries/day cap: each
    // company costs up to 4 summary requests, so ~1-5 companies/run stays well
    // inside it. Least-recently-checked first, so consecutive runs ROTATE through
    // the universe instead of re-doing the same names.
    if (Number.isFinite(maxPerRun) && maxPerRun > 0 && tickers.length > maxPerRun) {
      const checkedAt = (t) => {
        const v = base.tearsheets.companies[t]?.checked_at;
        return v ? new Date(v).getTime() : 0; // never analyzed -> first in line
      };
      tickers = [...tickers].sort((a, b) => checkedAt(a) - checkedAt(b)).slice(0, maxPerRun);
      log(`MAX_PER_RUN=${maxPerRun} -> this run takes the ${tickers.length} least-recently-checked:`, tickers);
    }
    log(
      `refresh mode (${forceAll ? "manual: force ALL" : "scheduled: stale only"}): ` +
        `${tickers.length} ticker(s)`,
      tickers
    );
  }

  // ---- Auto-discovery: let the board fill itself -------------------------
  // Scope is every listed company (not a curated list): BSE's announcements feed
  // tells us who just filed a call recording / transcript, which the client
  // identified as the proxy for "Screener's AI summary is now up". Everything
  // beyond DAILY_COMPANY_CAP rolls to tomorrow rather than being dropped.
  let queueStats = null;
  let queueDate = null; // set once discovery plans a day; drives the roll-over write
  if (!single && process.env.DISCOVER !== "0") {
    const today = nowIso().slice(0, 10);
    let discoveredTickers = [];
    let discovered = [];
    try {
      discovered = await discoverConcalls({ days: DISCOVER_DAYS });
      log(`discovery: ${discovered.length} company(ies) filed a concall in the last ${DISCOVER_DAYS} day(s)`);
    } catch (e) {
      log(`discovery skipped (${e.message}) — continuing with the tracked list`);
    }
    if (discovered.length) discoveryNames = discovered; // resolved after login
    const plan = planDay(base.queue, [], today, DAILY_COMPANY_CAP);
    queueStats = plan.stats;
  }

  if (!tickers.length && !discoveryNames.length) {
    log("nothing to do");
    return;
  }

  // If the browser can't launch or Screener login fails, the target tickers
  // would otherwise sit "queued" forever. Mark them failed and exit cleanly.
  let session;
  try {
    session = await launchAndLogin();
  } catch (err) {
    log("browser/login init failed:", err.message);
    for (const t of tickers) {
      pending.jobs.set(t.toUpperCase(), {
        status: "failed",
        finished_at: nowIso(),
        error: err.message,
        message: `Setup failed (${err.message}). Please retry.`,
      });
    }
    try {
      persistAndPush("analyze: setup failed");
    } catch {}
    process.exit(1);
  }

  const { browser, context, page } = session;
  try {
    // Resolve discovered company NAMES to Screener tickers now that we're logged
    // in, then build today's work list: yesterday's leftovers first, then new
    // finds, capped at DAILY_COMPANY_CAP with the remainder rolling forward.
    if (discoveryNames.length) {
      const resolved = [];
      for (const c of discoveryNames) {
        const tk = await resolveTicker(context, c.name);
        if (tk) resolved.push(tk);
        else log(`discovery: could not resolve "${c.name}" to a Screener ticker`);
      }
      const today = nowIso().slice(0, 10);
      // Don't re-queue a company we already hold for the current cycle.
      const fresh = resolved.filter((t) => {
        const comp = base.tearsheets.companies[t];
        return !(comp && isCurrent(comp, base.__cycle));
      });
      const plan = planDay(base.queue, fresh, today, DAILY_COMPANY_CAP);
      queueStats = plan.stats;
      log(
        `queue: ${plan.stats.discovered} new + ${plan.stats.carried_over} carried -> ` +
          `${plan.stats.processing_today} today, ${plan.stats.pending_tomorrow} tomorrow (cap ${plan.stats.cap})`
      );
      // Discovered names lead, then tomorrow's queue, then the tracked list.
      // This is a CANDIDATE POOL, not the work list: the cap counts companies
      // DELIVERED, so if one has no summary and no transcript the loop pulls the
      // next candidate instead of finishing a company short. Whatever the loop
      // never reaches rolls over as tomorrow's pending.
      const seen = new Set(plan.today);
      const rest = [];
      for (const t of [...plan.pending, ...tickers]) {
        if (seen.has(t)) continue;
        seen.add(t);
        rest.push(t);
      }
      tickers = [...plan.today, ...rest];
      queueDate = today;
      pending.queue = {
        date: today,
        pending: plan.pending,
        processed: (base.queue?.date === today ? base.queue.processed || 0 : 0),
        stats: plan.stats,
      };
      persistAndPush("analyze: discovery queue updated");
    }

    // Counted separately on purpose. "Attempted" is not "on the dashboard": a
    // company can be scraped, fail to yield a summary or transcript, and still
    // have been worked on. Reporting those together read as "6 done" on a day
    // when nothing new appeared, so the two are now kept apart.
    //
    // The TARGET is companies delivered, not companies tried. On a day when 50
    // names report and 5 of the first 20 have nothing readable on Screener yet,
    // we keep drawing from the remaining candidates until 20 are on the board.
    // ATTEMPT_BUDGET stops that from becoming unbounded: each company costs up
    // to 2 metered summary views against Screener's 80/day, so 2x the cap is the
    // most we can spend chasing a target of `cap` before the quota is the binding
    // constraint anyway.
    const target = single
      ? tickers.length
      : Number.isFinite(maxPerRun) && maxPerRun > 0
        ? Math.min(maxPerRun, DAILY_COMPANY_CAP)
        : DAILY_COMPANY_CAP;
    const attemptBudget = single
      ? tickers.length
      : parseInt(process.env.ATTEMPT_BUDGET || "", 10) || target * 2;
    let addedCount = 0;
    let failedCount = 0;
    let attempts = 0;
    const untouched = [];
    const failedTickers = []; // re-checked tomorrow — see RETRY_DAYS

    for (const t of tickers) {
      // Target met, or we have spent as many attempts as the quota allows: every
      // remaining candidate rolls forward untouched rather than being dropped.
      if (addedCount >= target || attempts >= attemptBudget) {
        untouched.push(t);
        continue;
      }
      attempts++;
      try {
        const outcome = await analyzeTicker(page, context, t, base);
        if (outcome === "added") addedCount++;
        else if (outcome === "failed") { failedCount++; failedTickers.push(t.toUpperCase()); }
        if (outcome === "rate_limited") {
          // Every remaining company would hit the same cap and be rebuilt from
          // transcripts. Stop here so they keep their existing data intact.
          const left = tickers.slice(tickers.indexOf(t) + 1);
          untouched.push(...left); // they keep their turn tomorrow
          log(
            `STOPPING: Screener's daily AI-summary limit (80/day) was reached. ` +
              `${left.length} company(ies) left untouched: ${left.join(", ") || "(none)"}. ` +
              `The cap resets daily — re-run then to finish.`
          );
          break;
        }
      } catch (err) {
        failedCount++;
        failedTickers.push(t.toUpperCase());
        log(`ticker ${t} crashed:`, err.message);
        pending.jobs.set(t.toUpperCase(), {
          status: "failed",
          finished_at: nowIso(),
          error: err.message,
          message: `Analysis failed for ${t}. Please retry.`,
        });
        try {
          persistAndPush(`analyze: ${t} failed`);
        } catch {}
      }
    }
    // Record how much of today's allowance we actually used, so tomorrow's run
    // (and the dashboard counter) start from the truth. `processed` still means
    // "attempted" — it is what paces the daily cap, since a failed attempt costs
    // Screener views all the same. `added`/`failed` are what the dashboard shows.
    if (pending.queue) {
      const attempted = addedCount + failedCount;
      pending.queue.processed = (pending.queue.processed || 0) + attempted;
      pending.queue.added = (pending.queue.added || 0) + addedCount;
      pending.queue.failed = (pending.queue.failed || 0) + failedCount;
      if (pending.queue.stats) {
        pending.queue.stats.already_processed_today = pending.queue.processed;
        pending.queue.stats.added_today = pending.queue.added;
        pending.queue.stats.failed_today = pending.queue.failed;
      }
      // Roll forward what the loop never got to. Computed from the actual run,
      // not from planDay's up-front guess, so a company promoted mid-run to
      // replace a failure isn't also queued for tomorrow.
      if (queueDate) {
        // Re-check what produced nothing. "No summary and no transcript" almost
        // always means Screener has not published yet, not that the company is
        // uninteresting — and until now a failure was simply dropped, so a call
        // that appeared a day later was never picked up unless the announcements
        // feed happened to mention it again. Count the tries so a ticker that
        // never yields anything stops after RETRY_DAYS instead of retrying for
        // ever.
        const tries = { ...(base.queue?.date ? base.queue.retries || {} : {}) };
        for (const t of failedTickers) tries[t] = (tries[t] || 0) + 1;
        for (const t of [...pending.tearsheets.keys()]) delete tries[t]; // succeeded — forget it
        const retriable = failedTickers.filter((t) => (tries[t] || 0) <= RETRY_DAYS);
        const gaveUp = failedTickers.filter((t) => (tries[t] || 0) > RETRY_DAYS);
        for (const t of gaveUp) {
          delete tries[t];
          log(`giving up on ${t} after ${RETRY_DAYS} days with nothing on Screener`);
        }
        const seenNext = new Set();
        pending.queue.pending = [...untouched, ...retriable].filter(
          (t) => t && !seenNext.has(t) && seenNext.add(t)
        );
        pending.queue.retries = tries;
        if (pending.queue.stats) pending.queue.stats.pending_tomorrow = pending.queue.pending.length;
        if (retriable.length) log(`re-queued for tomorrow: ${retriable.join(", ")}`);
      }
      log(
        `queue: ${addedCount} added, ${failedCount} failed, ${attempted} attempted, ` +
          `${untouched.length} rolled to tomorrow (target ${target}, attempt budget ${attemptBudget})`
      );
      try { persistAndPush("analyze: queue counters updated"); } catch {}
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[analyze] fatal:", err);
  process.exit(1);
});
