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
import { launchAndLogin, scrapeCompany } from "./scrape-screener.mjs";
import { classifyQuarter, diffGuidance, diffRisks, editTearSheet } from "./classify.mjs";
import { MODEL } from "./llm.mjs";

const DIR = "public/data";
const FILES = {
  tracked: `${DIR}/tracked.json`,
  tearsheets: `${DIR}/tearsheets.json`,
  jobs: `${DIR}/jobs.json`,
  metadata: `${DIR}/metadata.json`,
};
// Commit to the branch this workflow runs on (main in production; the feature
// branch during testing). GITHUB_REF_NAME is set by Actions.
const BRANCH = process.env.TARGET_BRANCH || process.env.GITHUB_REF_NAME || "main";
const STALE_DAYS = 80;
const REFRESH_THROTTLE_DAYS = 3; // don't re-scrape a stale name more often than this
const MAX_QUARTERS = 4;

const log = (...a) => console.log("[analyze]", ...a);

/* ---- JSON store helpers ---- */
const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");

function loadStores() {
  return {
    tracked: readJson(FILES.tracked, { companies: [], updated_at: null }),
    tearsheets: readJson(FILES.tearsheets, { companies: {} }),
    jobs: readJson(FILES.jobs, { jobs: {} }),
    metadata: readJson(FILES.metadata, { updated_at: null, count: 0 }),
  };
}

/* Pending mutations — re-applied onto the latest base on every persist so a
   push rejection can be resolved by rebasing our LOGICAL changes, never text. */
const pending = {
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
  for (const q of [...newQuarters, ...baseQuarters]) {
    const key = monthKey(q);
    const cur = byMonth.get(key);
    if (!cur) byMonth.set(key, q);
    else if (day(q) > 1 && day(cur) === 1) byMonth.set(key, q); // upgrade to the precise-dated record
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

function persistAndPush(message) {
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
}

/* ---- helpers ---- */
function topGuidanceHeadline(ledger = []) {
  const specific = ledger.find((g) => g.specificity === "specific");
  return (specific || ledger[0])?.statement || null;
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
  const scrape = await scrapeCompany(page, context, T);
  if (scrape.error) {
    pending.jobs.set(T, {
      status: "failed",
      finished_at: nowIso(),
      error: scrape.error,
      message: `Couldn't fetch ${T}'s latest concall. ${scrape.error}`,
    });
    persistAndPush(`analyze: ${T} failed`);
    return;
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

  const classifiedNewestFirst = [];
  for (const q of chronological) {
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
      model: MODEL,
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
}

/* ============================================================================
   Main
   ========================================================================== */
async function main() {
  const single = (process.env.TICKER || "").trim().toUpperCase();
  const base = loadStores();

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
    log(
      `refresh mode (${forceAll ? "manual: force ALL" : "scheduled: stale only"}): ` +
        `${tickers.length} ticker(s)`,
      tickers
    );
  }

  if (!tickers.length) {
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
    for (const t of tickers) {
      try {
        await analyzeTicker(page, context, t, base);
      } catch (err) {
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
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[analyze] fatal:", err);
  process.exit(1);
});
