/**
 * app.js — Daksham Capital · Concall Tracker (Step 1)
 * ===================================================
 * All front-end logic:
 *   - Live company search (POST /api/search via the Worker)
 *   - Analyze plumbing (passcode -> POST /api/analyze -> workflow dispatch)
 *   - Live feed + KPIs + sector donut (reads committed JSON in public/data/)
 *   - Tear-sheet placeholder modal + basic PDF export
 *   - ~20s polling so results appear the moment the pipeline commits them
 *
 * The dashboard's only source of truth is the committed JSON files. Heavy work
 * (Screener scraping + AI) happens later in GitHub Actions and commits results
 * back — the UI here is already wired for that.
 */

import {
  qs,
  qsa,
  escapeHtml,
  debounce,
  refreshIcons,
  gradientFor,
  initials,
  fmtDate,
  relTime,
  toast,
} from "./ui.js";
import * as Sectors from "./sectors.js";
import { initProgress, registerJob } from "./progress.js";
import { exportReportPdf, buildReportModel, fileName, quarterMatrix } from "./report.js";
import { exportTearSheetXlsx } from "./export-xlsx.js";

/* ============================================================================
   Config & constants
   ========================================================================== */
const API = { search: "/api/search", analyze: "/api/analyze", health: "/api/health" };
const DATA = {
  tracked: "./data/tracked.json",
  tearsheets: "./data/tearsheets.json",
  jobs: "./data/jobs.json",
  metadata: "./data/metadata.json",
};
const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE = 300;
const POLL_MS = 20000;

// The FIXED 11-section framework. Order + ids stay constant so tear sheets read
// the same quarter to quarter. `id`s match the classifier (screener-test/classify.mjs).
const SECTIONS = [
  { id: "FIN", title: "Financial Performance", icon: "bar-chart-3" },
  { id: "ORD", title: "Order Book & Demand", icon: "clipboard-list" },
  { id: "SEG", title: "Segment & Product Performance", icon: "layers" },
  { id: "TECH", title: "Product & Technology", icon: "cpu" },
  { id: "MFG", title: "Manufacturing & Capacity", icon: "factory" },
  { id: "GEO", title: "Geography & Distribution", icon: "map" },
  { id: "SUP", title: "Supply Chain & Operations", icon: "truck" },
  { id: "MKT", title: "Market & Customer Strategy", icon: "users" },
  { id: "STRAT", title: "Strategic Initiatives & M&A", icon: "target" },
  { id: "RISK", title: "Risks & External Factors", icon: "shield-alert" },
  { id: "GUID", title: "Guidance & Outlook", icon: "compass" },
];
// Fast id -> { title, icon, grad } lookup for tear-sheet rendering.
const SECTION_BY_ID = {};

// Cohesive palette (matches the CSS gradient tokens) for charts + section icons.
const PALETTE = [
  "#7c3aed", "#6366f1", "#3b82f6", "#06b6d4",
  "#14b8a6", "#10b981", "#f59e0b", "#ec4899",
  "#f43f5e", "#0ea5e9", "#8b5cf6",
];
const SECTION_GRADS = [
  "linear-gradient(135deg,#7c3aed,#6366f1)",
  "linear-gradient(135deg,#6366f1,#3b82f6)",
  "linear-gradient(135deg,#3b82f6,#06b6d4)",
  "linear-gradient(135deg,#06b6d4,#14b8a6)",
  "linear-gradient(135deg,#14b8a6,#10b981)",
  "linear-gradient(135deg,#10b981,#f59e0b)",
  "linear-gradient(135deg,#f59e0b,#ec4899)",
  "linear-gradient(135deg,#ec4899,#f43f5e)",
  "linear-gradient(135deg,#f43f5e,#8b5cf6)",
  "linear-gradient(135deg,#8b5cf6,#6366f1)",
  "linear-gradient(135deg,#0ea5e9,#7c3aed)",
];
SECTIONS.forEach((s, i) => {
  SECTION_BY_ID[s.id] = { ...s, grad: SECTION_GRADS[i % SECTION_GRADS.length] };
});

/* ============================================================================
   State
   ========================================================================== */
const state = {
  // search
  query: "",
  results: [], // [{ ticker, name, industry, country }]
  activeIndex: -1,
  searchSeq: 0, // guards against out-of-order responses
  // selection
  selected: null, // { ticker, name, industry, country }
  // analyze
  passcode: null, // cached in-memory only for this session (never persisted)
  optimistic: [], // locally-queued companies not yet in tracked.json
  freshTickers: new Set(), // drives the NEW pulse this session
  // data (from committed JSON)
  tracked: { companies: [], updated_at: null },
  tearsheets: { companies: {} },
  jobs: { jobs: {} },
  metadata: { updated_at: null, count: 0 },
  // charts / polling / views
  sectorChart: null,
  pollTimer: null,
  currentSheet: null,
  view: "overview", // "overview" | "sectors"
  boardRows: [], // done-only rows on the board (source for feed search/paging)
  feedShown: 5, // visible feed rows (grows +5 via "show more")
  feedQuery: "", // feed table search filter
  pendingAnalyze: null,
  sheetMode: "single", // tear-sheet key figures: "single" (latest) | "multi" (last 4 concalls)
};

// CDN capability flags (graceful degradation if a script was blocked).
const HAS = {
  echarts: () => typeof window.echarts !== "undefined",
  jspdf: () => typeof window.jspdf !== "undefined",
  html2canvas: () => typeof window.html2canvas !== "undefined",
};

/* ============================================================================
   Boot
   ========================================================================== */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireSearch();
  wireAnalyze();
  wireModals();
  wireShortcuts();
  wireViewTabs();
  Sectors.initSectors({ onOpenCompany: openCompanyByTicker });
  initProgress({
    refresh: async () => {
      await loadData();
      renderAll();
    },
    getJob: (t) => state.jobs.jobs?.[t] || null,
    getSheet: (t) => state.tearsheets.companies?.[t] || null,
    onViewReport: (t) => openCompanyByTicker(t),
    onRetry: (job) => retryAnalyze(job),
  });
  initMunshotSdk();

  await loadData();
  renderAll();
  await checkHealth();

  // Reveal is handled by CSS fade-up classes already in the markup.
  refreshIcons();
}

/* ============================================================================
   Health check — reflects Worker configuration in the footer, non-blocking.
   ========================================================================== */
async function checkHealth() {
  try {
    const res = await fetch(API.health, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const h = await res.json();
    const foot = qs("#footStatus");
    if (foot) {
      foot.textContent = h.search_configured
        ? h.analyze_configured
          ? "Search + Analyze ready"
          : "Search ready · Analyze setup pending"
        : "Search not configured";
    }
  } catch {
    /* health is informational only */
  }
}

/* ============================================================================
   VIEW SWITCHER — Overview (dashboard) / Sectors
   ========================================================================== */
function wireViewTabs() {
  qsa(".vtab").forEach((t) =>
    t.addEventListener("click", () => setView(t.getAttribute("data-view")))
  );
}

function setView(view) {
  state.view = view;
  qs("#viewOverview").classList.toggle("hidden", view !== "overview");
  qs("#viewSectors").classList.toggle("hidden", view !== "sectors");
  qsa(".vtab").forEach((t) =>
    t.classList.toggle("active", t.getAttribute("data-view") === view)
  );
  const content = qs(".content");
  if (content) content.scrollTop = 0;
  if (view === "sectors") Sectors.showOverview(state.tearsheets.companies);
  // ECharts can't size while hidden — resize the donut when returning.
  else if (state.sectorChart) setTimeout(() => state.sectorChart.resize(), 40);
}

/** Deep-link into a sector's detail (used by the donut + tear-sheet tie-ins). */
function goToSector(key) {
  state.view = "sectors";
  qs("#viewOverview").classList.add("hidden");
  qs("#viewSectors").classList.remove("hidden");
  qsa(".vtab").forEach((t) =>
    t.classList.toggle("active", t.getAttribute("data-view") === "sectors")
  );
  const content = qs(".content");
  if (content) content.scrollTop = 0;
  Sectors.showDetail(key, state.tearsheets.companies);
}

/** Open a company's tear sheet by ticker (from the sector view). */
function openCompanyByTicker(ticker) {
  const row = buildFeed().find((r) => r.ticker === ticker);
  if (row) openTearSheet(row);
}

/* ============================================================================
   SEARCH
   ========================================================================== */
function wireSearch() {
  const input = qs("#searchInput");
  const box = qs("#searchBox");
  const dropdown = qs("#searchDropdown");

  const run = debounce(doSearch, SEARCH_DEBOUNCE);

  input.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    state.query = q;
    if (q.length < SEARCH_MIN) {
      run.cancel();
      box.classList.remove("loading");
      closeDropdown();
      return;
    }
    box.classList.add("loading");
    setDropdown(skeletonRows());
    openDropdown();
    run(q);
  });

  input.addEventListener("keydown", onSearchKeydown);
  input.addEventListener("focus", () => {
    if (state.results.length && state.query.length >= SEARCH_MIN) openDropdown();
  });

  // Close on outside click.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) closeDropdown();
  });
}

async function doSearch(q) {
  const seq = ++state.searchSeq;
  const box = qs("#searchBox");
  try {
    const res = await fetch(API.search, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json().catch(() => ({}));
    if (seq !== state.searchSeq) return; // a newer query superseded this one

    box.classList.remove("loading");

    if (!res.ok || data.success === false) {
      const msg =
        data.message || "Search is unavailable right now. Please try again.";
      setDropdown(stateRow("🔌", msg));
      openDropdown();
      state.results = [];
      return;
    }

    state.results = parseResults(data);
    if (!state.results.length) {
      setDropdown(stateRow("🔍", `No companies match “${escapeHtml(q)}”.`));
    } else {
      renderResults(state.results);
    }
    state.activeIndex = -1;
    openDropdown();
  } catch {
    if (seq !== state.searchSeq) return;
    box.classList.remove("loading");
    setDropdown(stateRow("⚠️", "Couldn't reach search. Check your connection."));
    openDropdown();
  }
}

/** Turn the API's ticker-keyed object into a sorted array (India first). */
function parseResults(data) {
  const results = data?.data?.results;
  if (!results || typeof results !== "object") return [];
  const rows = Object.entries(results).map(([ticker, arr]) => {
    const [country, name, industry] = Array.isArray(arr) ? arr : [];
    return {
      ticker,
      name: name || ticker,
      industry: industry || null,
      country: country || null,
    };
  });
  // India first (this dashboard targets Indian concalls), preserve order within.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ai = isIndia(a.r.country) ? 0 : 1;
      const bi = isIndia(b.r.country) ? 0 : 1;
      return ai - bi || a.i - b.i;
    })
    .map((x) => x.r);
}

const isIndia = (c) => (c || "").toLowerCase() === "india";

/* ---- Dropdown rendering ---- */
function renderResults(rows) {
  const indiaRows = rows.filter((r) => isIndia(r.country));
  const intlRows = rows.filter((r) => !isIndia(r.country));
  let html = "";

  // No "India" divider — India IS the universe. India rows lead; an
  // "International" divider only appears when there are non-India results.
  if (indiaRows.length) html += indiaRows.map((r) => rowHtml(r, false)).join("");
  if (intlRows.length) {
    html += `<div class="dd-group-label"><i data-lucide="globe" class="i16"></i> International</div>`;
    html += intlRows.map((r) => rowHtml(r, true)).join("");
  }
  setDropdown(html);

  // Bind clicks against the flat (India-first) order so keyboard + mouse agree.
  const flat = [...indiaRows, ...intlRows];
  qsa(".dd-row", qs("#searchDropdown")).forEach((el, idx) => {
    el.addEventListener("click", () => selectCompany(flat[idx]));
    el.addEventListener("mousemove", () => setActive(idx));
  });
  state.results = flat;
}

function rowHtml(r, secondary) {
  const industry = r.industry
    ? `<span>${escapeHtml(r.industry)}</span>`
    : `<span style="opacity:.6">Industry n/a</span>`;
  // India is the default universe — only tag a NON-India result to distinguish it.
  const country =
    r.country && !isIndia(r.country)
      ? `<span class="country-tag intl">${escapeHtml(r.country)}</span>`
      : "";
  return `
    <div class="dd-row ${secondary ? "secondary" : ""}" role="option">
      <div class="dd-main">
        <div class="dd-name">${escapeHtml(r.name)}</div>
        <div class="dd-meta">${industry}</div>
      </div>
      <div class="dd-right">
        ${country}
        <span class="ticker-pill">${escapeHtml(r.ticker)}</span>
      </div>
    </div>`;
}

function skeletonRows() {
  let h = "";
  for (let i = 0; i < 4; i++) {
    h += `
      <div class="dd-skel">
        <div style="flex:1">
          <div class="skel" style="height:13px;width:${55 + i * 8}%"></div>
          <div class="skel" style="height:10px;width:${35 + i * 5}%;margin-top:7px"></div>
        </div>
        <div class="skel" style="height:20px;width:64px;border-radius:999px"></div>
      </div>`;
  }
  return h;
}

const stateRow = (emoji, msg) =>
  `<div class="dd-state"><span class="emoji">${emoji}</span>${escapeHtml(msg)}</div>`;

function setDropdown(html) {
  qs("#searchDropdown").innerHTML = html;
  refreshIcons();
}
function openDropdown() {
  qs("#searchDropdown").classList.add("open");
  qs("#searchInput")?.setAttribute("aria-expanded", "true");
}
function closeDropdown() {
  qs("#searchDropdown").classList.remove("open");
  qs("#searchInput")?.setAttribute("aria-expanded", "false");
  state.activeIndex = -1;
}

/* ---- Keyboard navigation ---- */
function onSearchKeydown(e) {
  const dd = qs("#searchDropdown");
  const open = dd.classList.contains("open");
  const rows = qsa(".dd-row", dd);

  if (e.key === "ArrowDown" && open && rows.length) {
    e.preventDefault();
    setActive(Math.min(state.activeIndex + 1, rows.length - 1));
  } else if (e.key === "ArrowUp" && open && rows.length) {
    e.preventDefault();
    setActive(Math.max(state.activeIndex - 1, 0));
  } else if (e.key === "Enter") {
    if (open && state.activeIndex >= 0 && state.results[state.activeIndex]) {
      e.preventDefault();
      selectCompany(state.results[state.activeIndex]);
    }
  } else if (e.key === "Escape") {
    closeDropdown();
    e.target.blur();
  }
}

function setActive(idx) {
  const rows = qsa(".dd-row", qs("#searchDropdown"));
  state.activeIndex = idx;
  rows.forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    if (i === idx) el.scrollIntoView({ block: "nearest" });
  });
}

/* ---- Selection ---- */
function selectCompany(company) {
  if (!company) return;
  state.selected = { ...company };
  closeDropdown();

  const input = qs("#searchInput");
  input.value = company.name;

  qs("#selTicker").textContent = company.ticker;
  qs("#selName").textContent = company.name;
  qs("#selName").title = company.name;
  qs("#selection").classList.remove("hidden");
  refreshIcons();
}

/* ============================================================================
   ANALYZE — passcode gate + POST /api/analyze
   ========================================================================== */
function wireAnalyze() {
  qs("#analyzeBtn").addEventListener("click", () => {
    if (!state.selected) return;
    // If we already hold a passcode this session, skip the prompt.
    if (state.passcode) runAnalyze(state.passcode);
    else openPassModal();
  });
}

function openPassModal(error) {
  const modal = qs("#passModal");
  modal.classList.add("open");
  const input = qs("#passInput");
  input.value = "";
  setTimeout(() => input.focus(), 60);
  if (error) toast("err", "Passcode error", error);
}
function closePassModal() {
  qs("#passModal").classList.remove("open");
  // Drop any canceled retry context so it can't hijack the next normal Analyze.
  state.pendingAnalyze = null;
}

async function runAnalyze(passcode, company = state.selected) {
  if (!company) return;

  const btn = qs("#analyzeBtn");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spin"></span><span>Queuing…</span>`;

  try {
    const res = await fetch(API.analyze, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: company.ticker,
        name: company.name,
        industry: company.industry,
        country: company.country,
        passcode,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (data.ok && data.queued) {
      // Success — remember passcode for the session and open a progress card.
      state.passcode = passcode;
      state.pendingAnalyze = null;
      closePassModal();
      addOptimistic(company);
      registerJob(company); // global, tab-independent progress panel + poller
      toast("ok", "Analysis queued", data.message || `${company.name} is processing.`);
      renderAll();
    } else if (res.status === 401 || data.reason === "bad_passcode") {
      state.passcode = null;
      openPassModal(data.message || "That passcode didn't match.");
    } else if (data.configured === false) {
      // Not wired up yet — friendly, non-breaking message.
      closePassModal();
      toast("info", "Not switched on yet", data.message || "Analyze isn't configured yet.");
    } else {
      closePassModal();
      toast("err", "Couldn't queue", data.message || "Please try again in a moment.");
    }
  } catch {
    toast("err", "Network error", "Couldn't reach the server. Please try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    refreshIcons();
  }
}

/** Add a locally-queued company so the feed reacts instantly (pre-deploy). */
function addOptimistic(company) {
  const t = company.ticker.toUpperCase();
  state.freshTickers.add(t);
  if (!state.optimistic.some((c) => c.ticker.toUpperCase() === t)) {
    state.optimistic.push({
      ticker: t,
      name: company.name,
      industry: company.industry,
      country: company.country,
      queued_at: new Date().toISOString(),
      status: "queued",
    });
  }
}

/** Retry a failed run from the progress panel (re-dispatch the same ticker). */
function retryAnalyze(job) {
  const company = {
    ticker: job.ticker,
    name: job.name,
    industry: null,
    country: "India",
  };
  // Don't register a job (or start polling) until the request actually queues —
  // runAnalyze registers on a successful queue. Registering up-front would leave
  // a phantom, forever-polling card if the user cancels the passcode prompt.
  if (state.passcode) runAnalyze(state.passcode, company);
  else {
    state.pendingAnalyze = company;
    openPassModal();
  }
}

/* ============================================================================
   DATA LOADING (committed JSON is the app's memory)
   ========================================================================== */
async function loadData() {
  const bust = `?t=${Date.now()}`; // avoid stale caches while polling
  const [tracked, tearsheets, jobs, metadata] = await Promise.all([
    fetchJson(DATA.tracked + bust, { companies: [], updated_at: null }),
    fetchJson(DATA.tearsheets + bust, { companies: {} }),
    fetchJson(DATA.jobs + bust, { jobs: {} }),
    fetchJson(DATA.metadata + bust, { updated_at: null, count: 0 }),
  ]);
  state.tracked = tracked;
  state.tearsheets = tearsheets;
  state.jobs = jobs;
  state.metadata = metadata;

  // Drop optimistic rows once the real tracked.json has caught up.
  const trackedSet = new Set(
    (tracked.companies || []).map((c) => (c.ticker || "").toUpperCase())
  );
  state.optimistic = state.optimistic.filter(
    (o) => !trackedSet.has(o.ticker.toUpperCase())
  );
}

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

/* ============================================================================
   FEED MODEL — merge tracked + jobs + tearsheets (+ optimistic) into rows
   ========================================================================== */
/** The most useful one-line guidance statement for the feed headline. */
function topGuidanceHeadline(ledger) {
  if (!Array.isArray(ledger) || !ledger.length) return null;
  // Skip carried-forward (no_mention) guidance — it's historical, not current.
  const items = ledger.filter((g) => g && g.status !== "no_mention");
  const specific = items.find((g) => g.specificity === "specific");
  return (specific || items[0])?.statement || null;
}

function buildFeed() {
  const map = new Map();

  // Real tracked companies first.
  for (const c of state.tracked.companies || []) {
    const t = (c.ticker || "").toUpperCase();
    if (!t) continue;
    map.set(t, { ...c, ticker: t, _sort: c.added_at });
  }
  // Then optimistic ones not yet persisted.
  for (const o of state.optimistic) {
    const t = o.ticker.toUpperCase();
    if (!map.has(t)) map.set(t, { ...o, ticker: t, _sort: o.queued_at });
  }

  // Attach status / tearsheet / job info. The tear-sheet store is keyed by
  // ticker -> { company, ticker, industry, country, quarters:[newest..] }.
  const rows = [...map.values()].map((entry) => {
    const t = entry.ticker;
    const comp = state.tearsheets.companies?.[t] || null;
    const q0 = comp?.quarters?.[0] || null;
    const job = state.jobs.jobs?.[t] || null;

    // Prefer an ACTIVE job (queued/running/failed) over a cached tear sheet when
    // the job is newer — so a re-analysis shows its state and keeps polling
    // instead of being masked as "done" by the previous quarter.
    const jobTs = job?.finished_at || job?.started_at || job?.queued_at || null;
    const q0Ts = q0?.generated_at || q0?.concall_date || null;
    const jobActive = job && ["queued", "running", "failed"].includes(job.status);
    const jobNewer = jobTs && q0Ts ? String(jobTs) > String(q0Ts) : Boolean(job && !q0);

    let status;
    if (jobActive && (jobNewer || !q0)) status = job.status;
    else if (q0) status = "done";
    else if (job?.status) status = job.status;
    else if (entry.status) status = entry.status;
    else status = "queued";

    const concallDate = q0?.concall_date || entry.concall_date || null;
    const headline =
      topGuidanceHeadline(q0?.guidance_ledger) ||
      q0?.summary ||
      entry.guidance_headline ||
      null;
    const source = q0?.source || entry.source || null;

    const sortKey =
      concallDate || entry._sort || job?.queued_at || entry.added_at || "";

    return {
      ticker: t,
      name: comp?.company || entry.name || t,
      industry: comp?.industry || entry.industry || null,
      country: comp?.country || entry.country || null,
      concallDate,
      headline,
      source,
      status,
      hasTearsheet: Boolean(q0),
      failMessage: status === "failed" ? job?.message || job?.error || null : null,
      themes: q0?.themes || [],
      fresh: state.freshTickers.has(t),
      sortKey,
    };
  });

  // Newest first.
  rows.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  return rows;
}

/* ============================================================================
   RENDER — feed, KPIs, sector chart
   ========================================================================== */
function renderAll() {
  const feed = buildFeed();
  // The board shows ONLY successfully analyzed companies. In-flight / failed
  // runs live in the global progress dock — never as ghost rows on the board.
  const board = feed.filter((r) => r.hasTearsheet);
  state.boardRows = board;
  renderFeed(board);
  renderKpis(board);
  renderSectorChart(board);
  if (state.view === "sectors") Sectors.refresh(state.tearsheets.companies);
  renderIcons();
}

function renderIcons() {
  refreshIcons();
}

/* ---- Live feed table / empty state ---- */
function renderFeed(rows) {
  const container = qs("#feedContainer");
  if (!rows.length) {
    container.innerHTML = emptyFeedHtml();
    const cta = qs("#feedEmptyCta");
    if (cta) cta.addEventListener("click", () => qs("#searchInput").focus());
    refreshIcons();
    return;
  }

  // Filter by the table search, then reveal in pages of 5 (no long scroll).
  const q = (state.feedQuery || "").toLowerCase().trim();
  const filtered = q
    ? rows.filter((r) => `${r.name} ${r.ticker} ${r.industry || ""}`.toLowerCase().includes(q))
    : rows;
  const shown = Math.max(5, Math.min(state.feedShown || 5, filtered.length));
  const visible = filtered.slice(0, shown);
  const remaining = filtered.length - visible.length;

  const bodyHtml = visible.length
    ? visible.map((r) => feedRowHtml(r)).join("")
    : `<tr><td colspan="5" class="feed-nomatch">No companies match “${escapeHtml(state.feedQuery)}”.</td></tr>`;

  container.innerHTML = `
    <div class="feed-toolbar">
      <div class="feed-search">
        <i data-lucide="search" class="i16"></i>
        <input id="feedSearch" type="search" name="daksham-feed-filter" autocomplete="off"
          autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true"
          placeholder="Search concalls — company, ticker or sector…" value="${escapeHtml(state.feedQuery || "")}" />
      </div>
      <span class="feed-count">${filtered.length} ${filtered.length === 1 ? "company" : "companies"}</span>
    </div>
    <div class="feed-scroll">
      <table class="feed-table">
        <thead>
          <tr>
            <th>Company</th>
            <th class="hide-sm">Sector</th>
            <th class="hide-sm">Concall</th>
            <th>Guidance Headline</th>
            <th class="hide-sm" title="Analysis source">Src</th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
    <div class="feed-foot">${
      remaining > 0
        ? `<button class="feed-more" id="feedMore"><i data-lucide="chevron-down" class="i16"></i> Show ${Math.min(
            5,
            remaining
          )} more <span class="fm-rest">${remaining} left</span></button>`
        : shown > 5
        ? `<button class="feed-more ghost" id="feedLess"><i data-lucide="chevron-up" class="i16"></i> Show less</button>`
        : ""
    }</div>`;

  qsa(".feed-table tbody tr[data-ticker]", container).forEach((tr) => {
    tr.addEventListener("click", () => {
      const t = tr.getAttribute("data-ticker");
      const row = rows.find((r) => r.ticker === t);
      if (row) openTearSheet(row);
    });
  });
  qsa(".sector-link[data-goto-sector]", container).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      goToSector(el.getAttribute("data-goto-sector"));
    })
  );

  // Table search — filters + resets paging; keeps focus across re-render.
  const search = qs("#feedSearch");
  if (search) {
    const wasFocused = state._feedSearchFocused;
    search.addEventListener("input", (e) => {
      state.feedQuery = e.target.value;
      state.feedShown = 5;
      state._feedSearchFocused = true;
      renderFeed(state.boardRows);
    });
    search.addEventListener("blur", () => (state._feedSearchFocused = false));
    if (wasFocused) {
      search.focus();
      const v = search.value;
      search.setSelectionRange(v.length, v.length);
    }
  }
  const more = qs("#feedMore");
  if (more) more.addEventListener("click", () => { state.feedShown = shown + 5; renderFeed(state.boardRows); });
  const less = qs("#feedLess");
  if (less) less.addEventListener("click", () => { state.feedShown = 5; renderFeed(state.boardRows); });

  refreshIcons();
}

function feedRowHtml(r) {
  const grad = gradientFor(r.ticker);
  const sourceChip = sourceChipHtml(r.source);
  const headline = r.headline
    ? `<span class="headline">${escapeHtml(r.headline)}</span>`
    : `<span class="headline muted">Awaiting analysis…</span>`;
  const newBadge = r.fresh ? `<span class="new-badge">NEW</span>` : "";

  return `
    <tr data-ticker="${escapeHtml(r.ticker)}" class="${r.fresh ? "fresh" : ""}">
      <td>
        <div class="cell-co">
          <div class="co-avatar" style="background:${grad}">${escapeHtml(
    initials(r.name)
  )}</div>
          <div>
            <div class="co-name"><span class="co-name-text" title="${escapeHtml(
              r.name
            )}">${escapeHtml(r.name)}</span>${newBadge}</div>
            <div class="co-ticker">${escapeHtml(r.ticker)}</div>
          </div>
        </div>
      </td>
      <td class="hide-sm">${
        r.industry
          ? `<span class="sector-link" data-goto-sector="${escapeHtml(
              Sectors.sectorKeyFor(r.industry)
            )}" title="Open sector">${escapeHtml(r.industry)}</span>`
          : `<span style="color:var(--text-4)">—</span>`
      }</td>
      <td class="hide-sm mono" style="color:var(--text-3)">${
        r.concallDate ? escapeHtml(fmtDate(r.concallDate)) : "—"
      }</td>
      <td>${headline}${feedThemeChip(r.themes)}</td>
      <td class="hide-sm">${sourceChip}</td>
    </tr>`;
}

/** Compact first-theme chip for the feed headline cell. */
function feedThemeChip(themes) {
  const items = (themes || []).filter(Boolean);
  if (!items.length) return "";
  const t = items[0];
  const cls =
    { positive: "dir-pos", negative: "dir-neg", mixed: "dir-mix", neutral: "dir-neu" }[
      t.direction
    ] || "dir-neu";
  const more = items.length > 1 ? `<span class="theme-more">+${items.length - 1}</span>` : "";
  return `<span class="theme-chip sm ${cls}" title="${escapeHtml(
    t.note || ""
  )}"><span class="tc-dot"></span>${escapeHtml(t.label)}</span>${more}`;
}

function statusChipHtml(status, failMessage) {
  const map = {
    done: ["done", "check-circle-2", "Done"],
    queued: ["queued", "clock", "Queued"],
    running: ["running", "loader", "Processing"],
    failed: ["failed", "x-circle", "Failed"],
  };
  const [cls, icon, label] = map[status] || map.queued;
  const title =
    status === "failed" && failMessage ? ` title="${escapeHtml(failMessage)}"` : "";
  return `<span class="chip ${cls}"${title}><span class="cdot"></span>${escapeHtml(
    label
  )}</span>`;
}

// Compact icon-only source indicator for the feed's narrow Source column; the
// full label is exposed via the tooltip (a text pill clips at tablet widths).
function sourceChipHtml(source) {
  if (source === "ai_summary")
    return `<span class="chip src-ai src-ico" title="AI concall summary"><i data-lucide="sparkles" class="i16"></i></span>`;
  if (source === "transcript")
    return `<span class="chip src-transcript src-ico" title="Full transcript"><i data-lucide="file-text" class="i16"></i></span>`;
  return `<span class="chip src-none src-ico" title="Source pending">—</span>`;
}

function emptyFeedHtml() {
  return `
    <div class="empty">
      <div class="empty-ico"><i data-lucide="radar"></i></div>
      <h4>No calls analyzed yet</h4>
      <p>
        Search any listed company above and hit <strong>Analyze</strong>. Within
        a few minutes its latest earnings-concall tear sheet lands right here —
        and it stays tracked, auto-refreshing every quarter.
      </p>
      <button class="cta-hint" id="feedEmptyCta">
        <i data-lucide="search" class="i16"></i> Search a company to begin
      </button>
    </div>`;
}

/* ---- KPIs ---- */
function renderKpis(rows) {
  const trackedCount = rows.length;
  const sectors = new Set(
    rows.map((r) => r.industry).filter(Boolean)
  );
  const callsThisQuarter = rows.filter(
    (r) => r.concallDate && inCurrentQuarter(r.concallDate)
  ).length;

  qs("#kpiTracked").textContent = trackedCount;
  qs("#kpiSectors").textContent = sectors.size;
  qs("#kpiCalls").textContent = callsThisQuarter;

  const trackedSub = qs("#kpiTrackedSub");
  if (trackedCount > 0) {
    trackedSub.innerHTML = `<i data-lucide="trending-up" class="i16"></i> ${trackedCount} name${
      trackedCount === 1 ? "" : "s"
    } on the board`;
  } else {
    trackedSub.innerHTML = `<i data-lucide="minus" class="i16"></i> None yet — search to begin`;
  }

  const updated = state.metadata.updated_at || state.tracked.updated_at;
  qs("#kpiUpdated").textContent = updated ? relTime(updated) : "—";
  qs("#footUpdated").textContent = updated ? fmtDate(updated) : "—";
  refreshIcons();
}

function inCurrentQuarter(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return false;
  const now = new Date();
  return (
    Math.floor(d.getMonth() / 3) === Math.floor(now.getMonth() / 3) &&
    d.getFullYear() === now.getFullYear()
  );
}

/* ---- Sector donut (ECharts) ---- */
function renderSectorChart(rows) {
  const chartEl = qs("#sectorChart");
  const emptyEl = qs("#sectorChartEmpty");
  const legendEl = qs("#sectorLegend");

  // Aggregate ANALYZED companies by broad sector (so a slice always maps to a
  // sector detail — queued/failed companies have no sector model yet).
  const analyzed = rows.filter((r) => r.hasTearsheet);
  const counts = {};
  for (const r of analyzed) {
    const key = Sectors.sectorKeyFor(r.industry);
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  // Nothing tracked yet -> pure empty state.
  if (!entries.length) {
    chartEl.style.display = "none";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("span").textContent =
      "Sector mix appears as you analyze companies";
    legendEl.innerHTML = "";
    return;
  }

  // We have data -> always render the legend (works even without ECharts).
  renderSectorLegend(legendEl, entries, analyzed.length);

  // ECharts blocked -> keep the legend, note the chart is unavailable.
  if (!HAS.echarts()) {
    chartEl.style.display = "none";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("span").textContent =
      "Chart unavailable — sector mix listed below.";
    return;
  }

  chartEl.style.display = "block";
  emptyEl.style.display = "none";

  if (!state.sectorChart) {
    state.sectorChart = window.echarts.init(chartEl, null, { renderer: "canvas" });
    window.addEventListener("resize", () => state.sectorChart?.resize());
    // Click a slice -> open that sector's detail.
    state.sectorChart.on("click", (p) => {
      if (p?.name) goToSector(p.name);
    });
    chartEl.style.cursor = "pointer";
  }

  const data = entries.map(([name, value], i) => ({
    name,
    value,
    itemStyle: { color: PALETTE[i % PALETTE.length] },
  }));

  state.sectorChart.setOption({
    tooltip: {
      trigger: "item",
      formatter: (p) =>
        `${p.name}<br/><b>${p.value}</b> ${p.value === 1 ? "company" : "companies"} · ${p.percent}%`,
      backgroundColor: "rgba(15,23,42,0.92)",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
      extraCssText: "border-radius:10px;padding:8px 12px;box-shadow:0 8px 24px rgba(2,6,23,.28)",
    },
    series: [
      {
        type: "pie",
        radius: ["62%", "88%"],
        center: ["50%", "50%"],
        startAngle: 90,
        minAngle: 12, // keep 1-company sectors visible even when Auto dominates
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 6,
          borderColor: "rgba(255,255,255,0.92)",
          borderWidth: 3,
        },
        label: {
          show: true,
          position: "center",
          formatter: () => `{a|${analyzed.length}}\n{b|Analyzed}`,
          rich: {
            a: {
              fontSize: 32,
              fontWeight: 700,
              color: "#0f172a",
              fontFamily: "Space Grotesk",
              lineHeight: 34,
            },
            b: {
              fontSize: 11,
              fontWeight: 600,
              color: "#94a3b8",
              letterSpacing: 1,
              padding: [3, 0, 0, 0],
            },
          },
        },
        emphasis: {
          scale: true,
          scaleSize: 7,
          itemStyle: { shadowBlur: 16, shadowColor: "rgba(2,6,23,0.20)" },
        },
        labelLine: { show: false },
        data,
      },
    ],
  });
  state.sectorChart.resize();
}

/** Legend (top 6 sectors) with count + % — independent of ECharts, and each
 *  row deep-links into that sector's detail (mirrors clicking a donut slice). */
function renderSectorLegend(legendEl, entries, total) {
  const t = total || entries.reduce((n, [, v]) => n + v, 0) || 1;
  legendEl.innerHTML = entries
    .slice(0, 6)
    .map(([name, value], i) => {
      const pct = Math.round((value / t) * 100);
      return `
      <div class="legend-row" data-goto-sector="${escapeHtml(name)}" title="Open ${escapeHtml(
        name
      )}">
        <span class="legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="legend-name">${escapeHtml(name)}</span>
        <span class="legend-count mono">${value}</span>
        <span class="legend-pct">${pct}%</span>
      </div>`;
    })
    .join("");
  legendEl.querySelectorAll(".legend-row[data-goto-sector]").forEach((el) =>
    el.addEventListener("click", () => goToSector(el.getAttribute("data-goto-sector")))
  );
}

/* ============================================================================
   TEAR SHEET — renders the latest quarter (quarters[0]) from tearsheets.json.
   Falls back to a designed pending / failed state while analysis runs.
   ========================================================================== */
function openTearSheet(row) {
  const comp = state.tearsheets.companies?.[row.ticker] || null;
  const q = comp?.quarters?.[0] || null;
  state.currentSheet = { row, comp, q };

  qs("#sheetName").textContent = comp?.company || row.name;

  // Header meta pills.
  const pills = [];
  pills.push(`<span class="sh-pill mono">${escapeHtml(row.ticker)}</span>`);
  const industry = comp?.industry || row.industry;
  if (industry)
    pills.push(
      `<span class="sh-pill link" data-goto-sector="${escapeHtml(
        Sectors.sectorKeyFor(industry)
      )}"><i data-lucide="layers" class="i16"></i>${escapeHtml(
        industry
      )}<i data-lucide="arrow-up-right" class="i16"></i></span>`
    );
  const country = comp?.country || row.country;
  if (country)
    pills.push(`<span class="sh-pill"><i data-lucide="map-pin" class="i16"></i>${escapeHtml(country)}</span>`);
  const date = q?.concall_date || row.concallDate;
  pills.push(
    `<span class="sh-pill"><i data-lucide="calendar" class="i16"></i>${
      date ? escapeHtml(fmtDate(date)) : "Latest concall — pending"
    }</span>`
  );
  const source = q?.source || row.source;
  if (source === "ai_summary")
    pills.push(`<span class="sh-pill"><i data-lucide="sparkles" class="i16"></i>AI summary</span>`);
  else if (source === "transcript")
    pills.push(`<span class="sh-pill"><i data-lucide="file-text" class="i16"></i>Transcript</span>`);
  qs("#sheetMeta").innerHTML = pills.join("");
  qsa("[data-goto-sector]", qs("#sheetMeta")).forEach((el) =>
    el.addEventListener("click", () => {
      qs("#sheetModal").classList.remove("open");
      goToSector(el.getAttribute("data-goto-sector"));
    })
  );

  state.sheetMode = "single"; // every freshly-opened sheet starts on the latest concall
  qs("#sheetModal").classList.add("open");
  renderSheetBody(row, comp, q);
}

/** (Re)render the tear-sheet body for the current state.sheetMode, and wire its
 *  export buttons + the "This concall / Last N concalls" toggle. Re-called when
 *  the toggle flips so exports and tables follow the on-screen selection. */
function renderSheetBody(row, comp, q) {
  qs("#sheetScroll").innerHTML = q ? tearSheetRealHtml(q, comp, state.sheetMode) : tearSheetPendingHtml(row);

  const pdfBtn = qs("#sheetPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportPdf(row));
  const xlsxBtn = qs("#sheetXlsxBtn");
  if (xlsxBtn) xlsxBtn.addEventListener("click", () => exportExcel(row));
  qsa(".ts-mode", qs("#sheetScroll")).forEach((b) =>
    b.addEventListener("click", () => {
      const mode = b.getAttribute("data-mode") === "multi" ? "multi" : "single";
      if (mode === state.sheetMode) return;
      state.sheetMode = mode;
      renderSheetBody(row, comp, q);
    })
  );
  refreshIcons();
}

/* ---- Real tear sheet ---- */
function tearSheetRealHtml(q, comp, mode = "single") {
  const isFirst = (comp?.quarters?.length || 1) <= 1;
  const summary = q.summary
    ? `<div class="ts-summary"><i data-lucide="sparkles" class="i16"></i><span>${escapeHtml(q.summary)}</span></div>`
    : "";
  return (
    summary +
    themesBandHtml(q.themes) +
    guidanceBandHtml(q.guidance_ledger, isFirst) +
    riskBandHtml(q.risk_register) +
    sectionsHtml(q.sections, q.source_url, comp, mode) +
    insightsHtml(q.key_takeaways) +
    pdfActionsHtml()
  );
}

/* Themes chips (each colored by direction). */
function themesBandHtml(themes) {
  const items = (themes || []).filter(Boolean);
  if (!items.length) return "";
  const chips = items
    .map((t) => {
      const cls =
        { positive: "dir-pos", negative: "dir-neg", mixed: "dir-mix", neutral: "dir-neu" }[
          t.direction
        ] || "dir-neu";
      return `<span class="theme-chip ${cls}" title="${escapeHtml(t.note || "")}"><span class="tc-dot"></span>${escapeHtml(
        t.label
      )}</span>`;
    })
    .join("");
  return `<div class="band-title"><i data-lucide="hash" class="i16"></i> Themes</div><div class="theme-cloud">${chips}</div>`;
}

/* Guidance vs Delivery band. Carried-forward "no_mention" items are hidden (they
   clutter and confuse), and the "new" chip is suppressed — a plain first-time
   guidance item needs no jargon label; only real deltas (Raised/Lowered/…) get a
   chip so the "vs delivery" signal stays clear. */
function guidanceBandHtml(ledger, isFirst) {
  const items = (ledger || []).filter(Boolean).filter((g) => g.status !== "no_mention");
  const head = `<div class="band-title"><i data-lucide="scale" class="i16"></i> Guidance &amp; Outlook</div>`;
  if (!items.length)
    return head + `<div class="ts-empty-inline">No explicit forward guidance this quarter.</div>`;
  const note = isFirst
    ? `<div class="ts-firstq"><i data-lucide="info" class="i16"></i> First tracked quarter — “raised / lowered / met” deltas start next quarter.</div>`
    : "";
  const chips = items.map(guidanceItemHtml).join("");
  return head + note + `<div class="ledger-grid">${chips}</div>`;
}

function guidanceItemHtml(g) {
  const st = guidanceStatusMeta(g.status);
  const dir = directionMeta(g.direction);
  const showChip = g.status && g.status !== "new";
  return `
    <div class="ledger-item spec-${escapeHtml(g.specificity || "vague")}">
      <div class="ledger-top">
        <span class="ledger-metric">${escapeHtml(g.metric)}</span>
        ${showChip ? `<span class="chip ${st.cls}"><span class="cdot"></span>${st.label}</span>` : ""}
      </div>
      <div class="ledger-statement">${escapeHtml(g.statement)}</div>
      <div class="ledger-meta">
        <span class="ltag"><i data-lucide="${dir.icon}" class="i16"></i>${dir.label}</span>
        ${g.horizon ? `<span class="ltag">${escapeHtml(g.horizon)}</span>` : ""}
      </div>
    </div>`;
}

function guidanceStatusMeta(status) {
  const m = {
    new: ["gl-new", "New"],
    reiterated: ["gl-flat", "Reiterated"],
    raised: ["gl-up", "Raised"],
    lowered: ["gl-down", "Lowered"],
    achieved: ["gl-up", "Achieved"],
    missed: ["gl-down", "Missed"],
    pushed_out: ["gl-warn", "Pushed out"],
    dropped: ["gl-warn", "Dropped"],
    no_mention: ["gl-muted", "No mention"],
  };
  const [cls, label] = m[status] || m.new;
  return { cls, label };
}

function directionMeta(direction) {
  const m = {
    up: ["trending-up", "Up"],
    down: ["trending-down", "Down"],
    flat: ["minus", "Flat"],
    unclear: ["help-circle", "Unclear"],
  };
  const [icon, label] = m[direction] || m.unclear;
  return { icon, label };
}

/* Risk register — only risks actually flagged THIS quarter (carried-forward
   "no_mention" items are hidden). A chip appears only for a real change
   (Escalated / Easing / Resolved); a first-time risk shows plain. */
function riskBandHtml(risks) {
  const items = (risks || []).filter(Boolean).filter((r) => r.status !== "no_mention");
  if (!items.length) return "";
  const head = `<div class="band-title"><i data-lucide="shield-alert" class="i16"></i> Risk Register</div>`;
  const chips = items
    .map((r) => {
      const st = riskStatusMeta(r.status);
      const showChip = r.status && r.status !== "new";
      return `
        <div class="risk-item">
          <span class="risk-dot" aria-hidden="true"></span>
          <div class="risk-body">
            <div class="risk-name">${escapeHtml(r.risk)}${
              showChip ? ` <span class="chip ${st.cls} sm"><span class="cdot"></span>${st.label}</span>` : ""
            }</div>
            ${r.note ? `<div class="risk-note">${escapeHtml(r.note)}</div>` : ""}
          </div>
        </div>`;
    })
    .join("");
  return head + `<div class="risk-grid">${chips}</div>`;
}

function riskStatusMeta(status) {
  const m = {
    new: ["gl-down", "New"],
    escalated: ["gl-down", "Escalated"],
    stable: ["gl-warn", "Stable"],
    easing: ["gl-up", "Easing"],
    resolved: ["gl-up", "Resolved"],
    no_mention: ["gl-muted", "No mention"],
  };
  const [cls, label] = m[status] || m.new;
  return { cls, label };
}

/* The 11 sections — render only those with content. */
function sectionsHtml(sections, sourceUrl, comp, mode = "single") {
  const list = (sections || []).filter(
    (s) => s && (s.key_figures?.length || s.subsections?.some((x) => x.points?.length))
  );
  if (!list.length) return "";
  // Toggle only when there's history to compare against.
  const nQ = (comp?.quarters || []).length;
  const toggle =
    nQ > 1
      ? `<div class="ts-modes" role="tablist" aria-label="Key figures range">
          <button class="ts-mode ${mode !== "multi" ? "on" : ""}" data-mode="single" role="tab" aria-selected="${mode !== "multi"}">This concall</button>
          <button class="ts-mode ${mode === "multi" ? "on" : ""}" data-mode="multi" role="tab" aria-selected="${mode === "multi"}">Last ${Math.min(4, nQ)} concalls</button>
        </div>`
      : "";
  const head = `<div class="band-title band-title-row"><span class="bt-label"><i data-lucide="layout-grid" class="i16"></i> The 11-Section Tear Sheet</span>${toggle}</div>`;
  return head + `<div class="ts-sections">${list.map((s) => sectionCardHtml(s, sourceUrl, comp, mode)).join("")}</div>`;
}

/** Treat empty / literal "null"/"undefined" strings as absent (model artifacts). */
function cleanField(v) {
  const s = (v ?? "").toString().trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : "";
}

/** Bullet points, collapsing a long list behind a native <details> toggle so a
 *  richer section stays scannable. (exportPdf opens all details before capture.) */
function pointsHtml(points) {
  const pts = (points || []).filter(Boolean);
  if (pts.length <= 6) return `<ul>${pts.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`;
  const head = pts.slice(0, 4);
  const rest = pts.slice(4);
  return `<ul>${head.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
    <details class="more-points"><summary>Show ${rest.length} more</summary>
      <ul>${rest.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
    </details>`;
}

function sectionCardHtml(s, sourceUrl, comp, mode = "single") {
  const meta = SECTION_BY_ID[s.id] || { title: s.title, icon: "dot", grad: SECTION_GRADS[0] };
  const figs = (s.key_figures || []).filter(Boolean);
  const subs = (s.subsections || []).filter((x) => x.points?.length);

  // A per-row "verify at source" link (opens the concall the figure came from).
  const srcCell = sourceUrl
    ? `<a class="kf-src" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener" title="Cross-verify this figure at the source concall"><i data-lucide="external-link" class="i16"></i></a>`
    : "";

  let figTable = "";
  if (mode === "multi" && (comp?.quarters || []).length > 1) {
    // Last-4-concalls view: one value column per concall, metrics matched by label.
    const mx = quarterMatrix(comp.quarters, s.id);
    figTable = mx.rows.length ? kfMatrixHtml(mx) : "";
  } else if (figs.length) {
    figTable = `<table class="kf-table">
        <thead><tr><th>Metric</th><th>Value</th><th class="hide-sm">Period</th><th>Type</th><th class="kf-src-h" title="Verify at source">Src</th></tr></thead>
        <tbody>${figs
          .map(
            (f) => `<tr>
            <td class="kf-label">${escapeHtml(f.label)}</td>
            <td class="kf-value">${escapeHtml(f.value)}${kfUnitHtml(f.value, f.unit)}</td>
            <td class="kf-period hide-sm">${cleanField(f.period) ? escapeHtml(cleanField(f.period)) : "—"}</td>
            <td>${kindChip(f.kind)}</td>
            <td class="kf-src-cell">${srcCell}</td>
          </tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  const subsHtml = subs.length
    ? `<div class="subsecs">${subs
        .map(
          (ss) => `<div class="subsec">
            ${ss.label ? `<div class="subsec-label">${escapeHtml(ss.label)}</div>` : ""}
            ${pointsHtml(ss.points)}
          </div>`
        )
        .join("")}</div>`
    : "";

  return `
    <div class="ts-section">
      <div class="ts-sec-head">
        <span class="sec-ico" style="background:${meta.grad}"><i data-lucide="${meta.icon}" class="i16"></i></span>
        <h4>${escapeHtml(s.title || meta.title)}</h4>
      </div>
      ${figTable}${subsHtml}
    </div>`;
}

/** Last-4-concalls key-figure matrix: Metric + one value column per concall,
 *  latest on the right and emphasised. Cells absent in a quarter show a dot. */
function kfMatrixHtml(mx) {
  const last = mx.cols.length - 1;
  const head = mx.cols
    .map((c, i) => `<th class="kf-q${i === last ? " kf-q-latest" : ""}">${escapeHtml(c.label)}</th>`)
    .join("");
  const body = mx.rows
    .map(
      (r) => `<tr><td class="kf-label">${escapeHtml(r.label)}</td>${r.cells
        .map((v, i) => `<td class="kf-value kf-q${i === last ? " kf-q-latest" : ""}">${v == null ? `<span class="kf-na">·</span>` : escapeHtml(v)}</td>`)
        .join("")}</tr>`
    )
    .join("");
  return `<div class="kf-mx-wrap"><table class="kf-table kf-matrix">
      <thead><tr><th>Metric</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

/** Render the unit chip, but skip a unit the value already carries
 *  (e.g. value "25%" + unit "%", or "54,000 Cr" + unit "Cr"). */
function kfUnitHtml(value, unit) {
  const u = cleanField(unit);
  if (!u) return "";
  const v = String(value ?? "").trim().toLowerCase();
  const uu = u.toLowerCase();
  // Skip a unit the value already carries — suffix ("25%" + "%") or prefix
  // ("INR50,000 crores" + "INR", common for currency tokens).
  if (v && (v.endsWith(uu) || v.startsWith(uu))) return "";
  return ` <span class="kf-unit">${escapeHtml(u)}</span>`;
}

function kindChip(kind) {
  const m = {
    reported: ["kc-reported", "Reported"],
    guidance: ["kc-guidance", "Guidance"],
    target: ["kc-target", "Target"],
    market_size: ["kc-market", "Market size"],
  };
  const [cls, label] = m[kind] || m.reported;
  return `<span class="kchip ${cls}">${label}</span>`;
}

/* Key Takeaways — the verbatim highlights from the concall (full width). */
function insightsHtml(takeaways) {
  const t = (takeaways || []).filter(Boolean);
  if (!t.length) return "";
  const head = `<div class="band-title"><i data-lucide="lightbulb" class="i16"></i> Key Takeaways</div>`;
  return (
    head +
    `<div class="insight-card takeaways full">
      <ul>${t.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
    </div>`
  );
}

function pdfActionsHtml() {
  return `
    <div class="ts-export-bar">
      <span class="ts-export-note"><i data-lucide="shield-check" class="i16"></i> Munshot · Prepared for Daksham Capital</span>
      <div class="ts-export-btns">
        <button class="btn ghost sm" id="sheetXlsxBtn"><i data-lucide="sheet" class="i16"></i> Excel</button>
        <button class="btn sm" id="sheetPdfBtn"><i data-lucide="file-down" class="i16"></i> Download PDF</button>
      </div>
    </div>`;
}

/* ---- Pending / failed state (designed, never blank) ---- */
function tearSheetPendingHtml(row) {
  const failed = row.status === "failed";
  const note = failed
    ? `<div class="ts-note err"><i data-lucide="alert-triangle" class="i16"></i><div><strong>Analysis failed.</strong> ${escapeHtml(
        row.failMessage || "Please retry from the Analyze button."
      )}</div></div>`
    : `<div class="ts-note"><i data-lucide="loader" class="i16"></i><div><strong>Analysis is running.</strong> This usually takes a few minutes — the tear sheet appears here automatically when it lands.</div></div>`;
  const sections = `
    <div class="band-title"><i data-lucide="layout-grid" class="i16"></i> The 11-Section Tear Sheet</div>
    <div class="sheet-grid">
      ${SECTIONS.map(
        (s, i) => `
        <div class="sec-card">
          <div class="sec-ico" style="background:${SECTION_GRADS[i % SECTION_GRADS.length]}">
            <i data-lucide="${s.icon}" class="i16"></i>
          </div>
          <h4>${escapeHtml(s.title)}</h4>
          <div class="placeholder"><i data-lucide="clock" class="i16"></i> ${
            failed ? "No data" : "Will populate after analysis"
          }</div>
          <div class="placeholder-lines"><div class="pl"></div><div class="pl"></div><div class="pl"></div></div>
        </div>`
      ).join("")}
    </div>`;
  return note + sections;
}

/* ============================================================================
   EXPORTS — a dedicated, print-optimised report (report.js) + branded Excel
   (export-xlsx.js). Neither screenshots the dashboard.
   ========================================================================== */
function currentQuarter(row) {
  const comp = state.tearsheets.companies?.[row.ticker] || null;
  const q = comp?.quarters?.[0] || null;
  return { comp, q };
}

async function exportPdf(row) {
  const { comp, q } = currentQuarter(row);
  if (!q) {
    toast("info", "Nothing to export", "This tear sheet has no analyzed quarter yet.");
    return;
  }
  if (!HAS.jspdf() || !HAS.html2canvas()) {
    toast("info", "PDF unavailable", "The PDF libraries didn't load. Check your connection and reopen.");
    return;
  }
  const btn = qs("#sheetPdfBtn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spin"></span> Preparing…`;
  }
  try {
    const model = buildReportModel(row.ticker, comp, q, { mode: state.sheetMode });
    await exportReportPdf(model, {
      onStage: (s) => {
        if (btn) btn.innerHTML = `<span class="btn-spin"></span> ${escapeHtml(s)}`;
      },
    });
    toast("ok", "PDF ready", `Saved ${fileName(model, "pdf")}`);
  } catch (err) {
    toast("err", "Export failed", "Couldn't build the PDF. Please try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
      refreshIcons();
    }
  }
}

async function exportExcel(row) {
  const { comp, q } = currentQuarter(row);
  if (!q) {
    toast("info", "Nothing to export", "This tear sheet has no analyzed quarter yet.");
    return;
  }
  const btn = qs("#sheetXlsxBtn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spin"></span> Building…`;
  }
  try {
    const model = buildReportModel(row.ticker, comp, q, { mode: state.sheetMode });
    await exportTearSheetXlsx(model);
    const ext = typeof window.ExcelJS !== "undefined" ? "xlsx" : "csv";
    toast("ok", "Excel ready", `Saved ${fileName(model, ext)}`);
  } catch (err) {
    toast("err", "Export failed", "Couldn't build the Excel file. Please try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
      refreshIcons();
    }
  }
}

/* ============================================================================
   MODALS + SHORTCUTS
   ========================================================================== */
function wireModals() {
  // Tear sheet
  qs("#sheetClose").addEventListener("click", closeSheet);
  qs("#sheetModal").addEventListener("click", (e) => {
    if (e.target.id === "sheetModal") closeSheet();
  });
  // Passcode
  qs("#passClose").addEventListener("click", closePassModal);
  qs("#passCancel").addEventListener("click", closePassModal);
  qs("#passSubmit").addEventListener("click", submitPass);
  qs("#passInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPass();
  });
  qs("#passModal").addEventListener("click", (e) => {
    if (e.target.id === "passModal") closePassModal();
  });
}

function submitPass() {
  const pass = qs("#passInput").value.trim();
  if (!pass) {
    toast("err", "Passcode required", "Please enter the analyze passcode.");
    return;
  }
  runAnalyze(pass, state.pendingAnalyze || state.selected);
}

function closeSheet() {
  qs("#sheetModal").classList.remove("open");
  state.currentSheet = null;
}

function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+K focuses search.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      qs("#searchInput").focus();
      qs("#searchInput").select();
    }
    // Escape closes any open modal.
    if (e.key === "Escape") {
      if (qs("#sheetModal").classList.contains("open")) closeSheet();
      if (qs("#passModal").classList.contains("open")) closePassModal();
    }
  });
}

/* ============================================================================
   POLLING — the global progress manager (progress.js) owns the single ~11s
   poller now: it refreshes the committed JSON, re-renders the board, and drives
   the progress dock. It stops itself once no run is in flight.
   ========================================================================== */

/* ============================================================================
   MUNSHOT DASHBOARD SDK — OPTIONAL progressive enhancement
   ----------------------------------------------------------------------------
   If this dashboard is ever embedded inside the Munshot host, the SDK lets it
   consume host context (e.g. a ticker the user selected elsewhere). It is fully
   optional: the app works standalone (its own Worker token + passcode model),
   and every SDK call is guarded so a blocked CDN never breaks the page.
   ========================================================================== */
function initMunshotSdk() {
  try {
    if (window.__munshotSdkBlocked) return;
    const SDK = window.MunshotDashboardSDK || window.MunshotDashboard || null;
    if (!SDK) return; // not embedded / not loaded — standalone mode

    const client =
      typeof SDK.init === "function"
        ? SDK.init({ name: "Daksham Concall Tracker", version: "0.1.0" })
        : SDK;

    // Signal readiness (method names are defensive across SDK versions).
    client?.ready?.();
    client?.signalReady?.();

    // React to a host-selected ticker by pre-filling the search.
    const onTicker = (payload) => {
      const ticker = payload?.ticker || payload?.symbol;
      const name = payload?.name || ticker;
      if (!ticker) return;
      selectCompany({
        ticker: String(ticker).toUpperCase(),
        name,
        industry: payload?.industry || null,
        country: payload?.country || "India",
      });
    };
    client?.subscribe?.("portfolio.ticker.select", onTicker);
    client?.on?.("ticker", onTicker);
  } catch {
    /* SDK is optional — never let it break standalone use */
  }
}
