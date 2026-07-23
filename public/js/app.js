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
import { exportReportPdf, buildReportModel, fileName } from "./report.js";
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
}
function closeDropdown() {
  qs("#searchDropdown").classList.remove("open");
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
  registerJob(company); // instant "queued" feedback in the panel
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

  const body = rows.map((r) => feedRowHtml(r)).join("");
  container.innerHTML = `
    <table class="feed-table">
      <thead>
        <tr>
          <th>Company</th>
          <th class="hide-sm">Sector</th>
          <th class="hide-sm">Concall</th>
          <th>Guidance Headline</th>
          <th class="hide-sm">Source</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;

  qsa(".feed-table tbody tr", container).forEach((tr) => {
    tr.addEventListener("click", () => {
      const t = tr.getAttribute("data-ticker");
      const row = rows.find((r) => r.ticker === t);
      if (row) openTearSheet(row);
    });
  });
  // Sector cell -> open that sector (don't also open the tear sheet).
  qsa(".sector-link[data-goto-sector]", container).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      goToSector(el.getAttribute("data-goto-sector"));
    })
  );
  refreshIcons();
}

function feedRowHtml(r) {
  const grad = gradientFor(r.ticker);
  const statusChip = statusChipHtml(r.status, r.failMessage);
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
      <td>${statusChip}</td>
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

function sourceChipHtml(source) {
  if (source === "ai_summary")
    return `<span class="chip src-ai"><i data-lucide="sparkles" class="i16"></i>AI summary</span>`;
  if (source === "transcript")
    return `<span class="chip src-transcript"><i data-lucide="file-text" class="i16"></i>Transcript</span>`;
  return `<span class="chip src-none">—</span>`;
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

  qs("#sheetScroll").innerHTML = q ? tearSheetRealHtml(q, comp) : tearSheetPendingHtml(row);
  qs("#sheetModal").classList.add("open");

  const pdfBtn = qs("#sheetPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportPdf(row));
  const xlsxBtn = qs("#sheetXlsxBtn");
  if (xlsxBtn) xlsxBtn.addEventListener("click", () => exportExcel(row));
  refreshIcons();
}

/* ---- Real tear sheet ---- */
function tearSheetRealHtml(q, comp) {
  const isFirst = (comp?.quarters?.length || 1) <= 1;
  const summary = q.summary
    ? `<div class="ts-summary"><i data-lucide="sparkles" class="i16"></i><span>${escapeHtml(q.summary)}</span></div>`
    : "";
  return (
    summary +
    themesBandHtml(q.themes) +
    guidanceBandHtml(q.guidance_ledger, isFirst) +
    riskBandHtml(q.risk_register) +
    sectionsHtml(q.sections) +
    insightsHtml(q.key_takeaways, q.pressing_questions) +
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

/* Guidance vs Delivery band — the ledger as colorful status chips. */
function guidanceBandHtml(ledger, isFirst) {
  const items = (ledger || []).filter(Boolean);
  const head = `<div class="band-title"><i data-lucide="scale" class="i16"></i> Guidance vs Delivery</div>`;
  if (!items.length)
    return head + `<div class="ts-empty-inline">No explicit forward guidance this quarter.</div>`;
  const note = isFirst
    ? `<div class="ts-firstq"><i data-lucide="info" class="i16"></i> First tracked quarter — deltas appear next quarter.</div>`
    : "";
  const chips = items.map(guidanceItemHtml).join("");
  return head + note + `<div class="ledger-grid">${chips}</div>`;
}

function guidanceItemHtml(g) {
  const st = guidanceStatusMeta(g.status);
  const dir = directionMeta(g.direction);
  return `
    <div class="ledger-item spec-${escapeHtml(g.specificity || "vague")}">
      <div class="ledger-top">
        <span class="ledger-metric">${escapeHtml(g.metric)}</span>
        <span class="chip ${st.cls}"><span class="cdot"></span>${st.label}</span>
      </div>
      <div class="ledger-statement">${escapeHtml(g.statement)}</div>
      <div class="ledger-meta">
        <span class="ltag"><i data-lucide="${dir.icon}" class="i16"></i>${dir.label}</span>
        ${g.horizon ? `<span class="ltag">${escapeHtml(g.horizon)}</span>` : ""}
        <span class="ltag spec">${escapeHtml(g.specificity || "")}</span>
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

/* Risk register — status-chipped list (deltas across quarters). */
function riskBandHtml(risks) {
  const items = (risks || []).filter(Boolean);
  if (!items.length) return "";
  const head = `<div class="band-title"><i data-lucide="shield-alert" class="i16"></i> Risk Register</div>`;
  const chips = items
    .map((r) => {
      const st = riskStatusMeta(r.status);
      return `
        <div class="risk-item">
          <span class="chip ${st.cls}"><span class="cdot"></span>${st.label}</span>
          <div class="risk-body">
            <div class="risk-name">${escapeHtml(r.risk)}</div>
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
function sectionsHtml(sections) {
  const list = (sections || []).filter(
    (s) => s && (s.key_figures?.length || s.subsections?.some((x) => x.points?.length))
  );
  if (!list.length) return "";
  const head = `<div class="band-title"><i data-lucide="layout-grid" class="i16"></i> The 11-Section Tear Sheet</div>`;
  return head + `<div class="ts-sections">${list.map(sectionCardHtml).join("")}</div>`;
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

function sectionCardHtml(s) {
  const meta = SECTION_BY_ID[s.id] || { title: s.title, icon: "dot", grad: SECTION_GRADS[0] };
  const figs = (s.key_figures || []).filter(Boolean);
  const subs = (s.subsections || []).filter((x) => x.points?.length);

  const figTable = figs.length
    ? `<table class="kf-table">
        <thead><tr><th>Metric</th><th>Value</th><th>Period</th><th>Type</th></tr></thead>
        <tbody>${figs
          .map(
            (f) => `<tr>
            <td class="kf-label">${escapeHtml(f.label)}</td>
            <td class="kf-value">${escapeHtml(f.value)}${
              cleanField(f.unit) ? ` <span class="kf-unit">${escapeHtml(cleanField(f.unit))}</span>` : ""
            }</td>
            <td class="kf-period">${cleanField(f.period) ? escapeHtml(cleanField(f.period)) : "—"}</td>
            <td>${kindChip(f.kind)}</td>
          </tr>`
          )
          .join("")}</tbody>
      </table>`
    : "";

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

/* Key Takeaways (Screener's words, verbatim) + Pressing Questions. */
function insightsHtml(takeaways, questions) {
  const t = (takeaways || []).filter(Boolean);
  const q = (questions || []).filter(Boolean);
  if (!t.length && !q.length) return "";
  const head = `<div class="band-title"><i data-lucide="lightbulb" class="i16"></i> Analyst Read</div>`;
  const tCard = `
    <div class="insight-card takeaways">
      <h4><i data-lucide="check-check" class="i16"></i> Key Takeaways <span class="verbatim">Screener · verbatim</span></h4>
      ${t.length ? `<ul>${t.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="ts-empty-inline">None provided.</div>`}
    </div>`;
  const qCard = `
    <div class="insight-card questions">
      <h4><i data-lucide="help-circle" class="i16"></i> Pressing Questions</h4>
      ${q.length ? `<ul>${q.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<div class="ts-empty-inline">None highlighted.</div>`}
    </div>`;
  return head + `<div class="two-col">${tCard}${qCard}</div>`;
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
    const model = buildReportModel(row.ticker, comp, q);
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
    const model = buildReportModel(row.ticker, comp, q);
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
