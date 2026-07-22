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

// The FIXED 11-section framework. Order is intentional and stays constant so
// tear sheets read the same quarter to quarter. (Prompt 3 fills the content.)
const SECTIONS = [
  { key: "financials", title: "Financials", icon: "bar-chart-3" },
  { key: "orderbook", title: "Order Book & Demand", icon: "clipboard-list" },
  { key: "segments", title: "Segments", icon: "layers" },
  { key: "product", title: "Product & Technology", icon: "cpu" },
  { key: "manufacturing", title: "Manufacturing & Capacity", icon: "factory" },
  { key: "geography", title: "Geography & Distribution", icon: "map" },
  { key: "supplychain", title: "Supply Chain & Operations", icon: "truck" },
  { key: "market", title: "Market & Customer", icon: "users" },
  { key: "strategy", title: "Strategy & M&A", icon: "target" },
  { key: "risks", title: "Risks", icon: "shield-alert" },
  { key: "guidance", title: "Guidance & Outlook", icon: "compass" },
];

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
  // charts / polling
  sectorChart: null,
  pollTimer: null,
  currentSheet: null,
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
  renderFrameworkChips();
  wireSearch();
  wireAnalyze();
  wireModals();
  wireShortcuts();
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

  if (indiaRows.length) {
    html += `<div class="dd-group-label"><i data-lucide="map-pin" class="i16"></i> India</div>`;
    html += indiaRows.map((r) => rowHtml(r, false)).join("");
  }
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
  const country = r.country
    ? `<span class="country-tag ${isIndia(r.country) ? "" : "intl"}">${escapeHtml(
        r.country
      )}</span>`
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

async function runAnalyze(passcode) {
  const company = state.selected;
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
      // Success — remember passcode for the session, add an optimistic row.
      state.passcode = passcode;
      closePassModal();
      addOptimistic(company);
      toast("ok", "Analysis queued", data.message || `${company.name} is processing.`);
      renderAll();
      startPolling();
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

  // Attach status / tearsheet / job info.
  const rows = [...map.values()].map((entry) => {
    const t = entry.ticker;
    const ts = state.tearsheets.companies?.[t] || null;
    const job = state.jobs.jobs?.[t] || null;

    let status = "queued";
    if (ts) status = "done";
    else if (job?.status) status = job.status;
    else if (entry.status) status = entry.status;

    const concallDate = ts?.concall_date || entry.concall_date || null;
    const headline = ts?.guidance_headline || entry.guidance_headline || null;
    const source = ts?.source || entry.source || null;
    const sortKey =
      concallDate || entry._sort || job?.queued_at || entry.added_at || "";

    return {
      ticker: t,
      name: entry.name || t,
      industry: entry.industry || null,
      country: entry.country || null,
      concallDate,
      headline,
      source,
      status,
      hasTearsheet: Boolean(ts),
      tearsheet: ts,
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
  renderFeed(feed);
  renderKpis(feed);
  renderSectorChart(feed);
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
  refreshIcons();
}

function feedRowHtml(r) {
  const grad = gradientFor(r.ticker);
  const statusChip = statusChipHtml(r.status);
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
          ? `<span style="color:var(--text-3)">${escapeHtml(r.industry)}</span>`
          : `<span style="color:var(--text-4)">—</span>`
      }</td>
      <td class="hide-sm mono" style="color:var(--text-3)">${
        r.concallDate ? escapeHtml(fmtDate(r.concallDate)) : "—"
      }</td>
      <td>${headline}</td>
      <td class="hide-sm">${sourceChip}</td>
      <td>${statusChip}</td>
    </tr>`;
}

function statusChipHtml(status) {
  const map = {
    done: ["done", "check-circle-2", "Done"],
    queued: ["queued", "clock", "Queued"],
    running: ["running", "loader", "Processing"],
    failed: ["failed", "x-circle", "Failed"],
  };
  const [cls, icon, label] = map[status] || map.queued;
  return `<span class="chip ${cls}"><span class="cdot"></span>${escapeHtml(
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

  // Aggregate by industry.
  const counts = {};
  for (const r of rows) {
    const key = r.industry || "Uncategorised";
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
  renderSectorLegend(legendEl, entries);

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
  }

  const data = entries.map(([name, value], i) => ({
    name,
    value,
    itemStyle: { color: PALETTE[i % PALETTE.length] },
  }));

  state.sectorChart.setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    series: [
      {
        type: "pie",
        radius: ["58%", "82%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 8, borderColor: "#fff", borderWidth: 3 },
        label: {
          show: true,
          position: "center",
          formatter: () => `{a|${rows.length}}\n{b|Tracked}`,
          rich: {
            a: { fontSize: 26, fontWeight: 700, color: "#0f172a", fontFamily: "Space Grotesk" },
            b: { fontSize: 11, color: "#94a3b8", padding: [4, 0, 0, 0] },
          },
        },
        emphasis: { scale: true, scaleSize: 6 },
        labelLine: { show: false },
        data,
      },
    ],
  });
  state.sectorChart.resize();
}

/** Legend list (top 5 sectors) — independent of ECharts. */
function renderSectorLegend(legendEl, entries) {
  legendEl.innerHTML = entries
    .slice(0, 5)
    .map(
      ([name, value], i) => `
      <div class="legend-row">
        <span class="legend-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(
          name
        )}</span>
        <span class="mono" style="color:var(--text-3)">${value}</span>
      </div>`
    )
    .join("");
}

/* ---- Framework chips ---- */
function renderFrameworkChips() {
  qs("#frameworkChips").innerHTML = SECTIONS.map(
    (s, i) => `
    <span class="fw-chip"><span class="n">${i + 1}</span>${escapeHtml(s.title)}</span>`
  ).join("");
  refreshIcons();
}

/* ============================================================================
   TEAR SHEET (placeholder layout — real data arrives in Prompt 3)
   ========================================================================== */
function openTearSheet(row) {
  state.currentSheet = row;
  qs("#sheetName").textContent = row.name;

  // Header meta pills.
  const pills = [];
  pills.push(`<span class="sh-pill mono">${escapeHtml(row.ticker)}</span>`);
  if (row.industry)
    pills.push(`<span class="sh-pill"><i data-lucide="layers" class="i16"></i>${escapeHtml(row.industry)}</span>`);
  if (row.country)
    pills.push(`<span class="sh-pill"><i data-lucide="map-pin" class="i16"></i>${escapeHtml(row.country)}</span>`);
  pills.push(
    `<span class="sh-pill"><i data-lucide="calendar" class="i16"></i>${
      row.concallDate ? escapeHtml(fmtDate(row.concallDate)) : "Latest concall — pending"
    }</span>`
  );
  if (row.source === "ai_summary")
    pills.push(`<span class="sh-pill"><i data-lucide="sparkles" class="i16"></i>AI summary</span>`);
  else if (row.source === "transcript")
    pills.push(`<span class="sh-pill"><i data-lucide="file-text" class="i16"></i>Transcript</span>`);
  qs("#sheetMeta").innerHTML = pills.join("");

  qs("#sheetScroll").innerHTML = tearSheetBodyHtml(row);
  qs("#sheetModal").classList.add("open");

  // Wire the PDF button.
  const pdfBtn = qs("#sheetPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportPdf(row));

  refreshIcons();
}

function tearSheetBodyHtml(row) {
  const isDone = row.hasTearsheet;

  // Guidance vs Delivery band (placeholder chips until the ledger exists).
  const band = `
    <div class="band-title"><i data-lucide="scale" class="i16"></i> Guidance vs Delivery</div>
    <div class="guidance-band" style="margin-bottom:22px">
      <div class="g-chip"><div class="g-label">Promised</div><div class="g-val">Will populate after analysis</div></div>
      <div class="g-chip"><div class="g-label">Delivered</div><div class="g-val">Will populate after analysis</div></div>
      <div class="g-chip"><div class="g-label">Verdict</div><div class="g-val">—</div></div>
    </div>`;

  // 11 section cards.
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
          <div class="placeholder"><i data-lucide="clock" class="i16"></i> Will populate after analysis</div>
          <div class="placeholder-lines"><div class="pl"></div><div class="pl"></div><div class="pl"></div></div>
        </div>`
      ).join("")}
    </div>`;

  // Key Takeaways + Pressing Questions.
  const insights = `
    <div class="band-title"><i data-lucide="lightbulb" class="i16"></i> Analyst Read</div>
    <div class="two-col">
      <div class="insight-card takeaways">
        <h4><i data-lucide="check-check" class="i16"></i> Key Takeaways</h4>
        <ul>
          <li>Populated from the concall once analysis completes.</li>
          <li>Three to five crisp, decision-useful points.</li>
        </ul>
      </div>
      <div class="insight-card questions">
        <h4><i data-lucide="help-circle" class="i16"></i> Pressing Questions</h4>
        <ul>
          <li>Open questions an analyst should ask next quarter.</li>
          <li>Gaps between guidance and disclosure.</li>
        </ul>
      </div>
    </div>`;

  const statusNote = isDone
    ? ""
    : `<div style="margin-top:22px;padding:14px 16px;border-radius:14px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.18);font-size:12.5px;color:var(--text-2);display:flex;gap:9px;align-items:center">
        <i data-lucide="info" class="i16" style="color:var(--brand-indigo);flex-shrink:0"></i>
        This is a live placeholder. The analysis engine (Screener AI summary → 11-section classifier) fills every card in a later step. The layout you see now is exactly how it will render.
      </div>`;

  const actions = `
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px">
      <button class="btn ghost sm" id="sheetPdfBtn"><i data-lucide="download" class="i16"></i> Download PDF</button>
    </div>`;

  return band + sections + insights + statusNote + actions;
}

/* ============================================================================
   PDF EXPORT (basic but working — richer report comes in Prompt 6)
   ========================================================================== */
async function exportPdf(row) {
  if (!HAS.jspdf() || !HAS.html2canvas()) {
    toast("info", "PDF unavailable", "The PDF libraries didn't load. Check your connection and reopen.");
    return;
  }
  const sheetEl = qs("#sheetEl");
  const scrollEl = qs("#sheetScroll");
  const btn = qs("#sheetPdfBtn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spin"></span> Preparing…`;
  }

  // Temporarily expand the sheet so the whole tear sheet is captured.
  const saved = {
    maxH: sheetEl.style.maxHeight,
    scrollOverflow: scrollEl.style.overflow,
    scrollMaxH: scrollEl.style.maxHeight,
  };
  sheetEl.style.maxHeight = "none";
  scrollEl.style.overflow = "visible";
  scrollEl.style.maxHeight = "none";

  try {
    const canvas = await window.html2canvas(sheetEl, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;

    let heightLeft = imgH;
    let position = 0;
    const imgData = canvas.toDataURL("image/png");
    pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
    pdf.save(`${row.ticker}-Daksham-concall-tearsheet.pdf`);
    toast("ok", "PDF ready", `Saved ${row.ticker}-Daksham-concall-tearsheet.pdf`);
  } catch (err) {
    toast("err", "Export failed", "Couldn't build the PDF. Please try again.");
  } finally {
    sheetEl.style.maxHeight = saved.maxH;
    scrollEl.style.overflow = saved.scrollOverflow;
    scrollEl.style.maxHeight = saved.scrollMaxH;
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
  runAnalyze(pass);
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
   POLLING — refresh JSON every ~20s while anything is pending
   ========================================================================== */
function hasPending() {
  const feed = buildFeed();
  return feed.some((r) => r.status !== "done" && r.status !== "failed");
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    await loadData();
    renderAll();
    if (!hasPending()) stopPolling();
  }, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

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
