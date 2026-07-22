/**
 * sectors.js — Sector Intelligence + between-quarter watch (Step 5).
 * ==================================================================
 * PURE computation from tearsheets.json (NO LLM) + rendering of the Sectors tab.
 * Serves the client's most-emphasized asks:
 *   - "a tracking point for every sector"
 *   - "what are the themes running in that sector"
 *   - watch a sector BETWEEN quarters (carry-forward points, no re-reading)
 *   - "compare across companies in one view" (consolidated table + read-across)
 *
 * Everything degrades gracefully with only 1-2 companies / no themes yet.
 */

import {
  qs,
  qsa,
  escapeHtml,
  fmtDate,
  relTime,
  gradientFor,
  initials,
  refreshIcons,
} from "./ui.js";

/* Section id -> short label (for "ties to" + read-across). */
const SECTION_TITLE = {
  FIN: "Financials",
  ORD: "Order Book & Demand",
  SEG: "Segments",
  TECH: "Product & Tech",
  MFG: "Manufacturing",
  GEO: "Geography",
  SUP: "Supply Chain",
  MKT: "Market & Customer",
  STRAT: "Strategy & M&A",
  RISK: "Risks",
  GUID: "Guidance",
};

const PALETTE = [
  "#7c3aed", "#6366f1", "#3b82f6", "#06b6d4",
  "#14b8a6", "#10b981", "#f59e0b", "#ec4899",
  "#f43f5e", "#0ea5e9", "#8b5cf6",
];

/* Theme / direction visual language (colors mirror the CSS variables). */
const DIR = {
  positive: { cls: "dir-pos", color: "#10b981", label: "Positive", icon: "trending-up" },
  negative: { cls: "dir-neg", color: "#f43f5e", label: "Negative", icon: "trending-down" },
  mixed: { cls: "dir-mix", color: "#f59e0b", label: "Mixed", icon: "shuffle" },
  neutral: { cls: "dir-neu", color: "#94a3b8", label: "Neutral", icon: "minus" },
};
const dirMeta = (d) => DIR[d] || DIR.neutral;

/* Guidance DIRECTION is directional, not sentiment (up isn't always "good" —
   think costs / debt / attrition), so it gets literal Up/Down labels and a
   neutral, non-red/green palette. */
const GUIDE_DIR = {
  up: { cls: "gdir-up", label: "Up", icon: "trending-up" },
  down: { cls: "gdir-down", label: "Down", icon: "trending-down" },
  flat: { cls: "gdir-flat", label: "Flat", icon: "minus" },
  unclear: { cls: "gdir-neu", label: "Unclear", icon: "help-circle" },
};

const QUIET_WEEKS = 6; // no call in ~6 weeks -> flag "quiet / watch"

/** End-of-month timestamp. Screener stores "Mon YYYY" as the 1st of the month,
 *  so measuring quiet from month-END avoids flagging a late-in-the-month call
 *  as quiet almost a month early. */
const endOfMonth = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
};

/* ============================================================================
   Editable industry -> broad sector mapping (swappable for the client's own
   peer-group list). Keys are lowercase substrings matched against the stored
   industry; first match wins, else the raw industry is its own sector.
   ========================================================================== */
// Ordered SPECIFIC-first (e.g. Pharma/biotech before the generic IT terms) and
// with over-broad substrings (like a bare "technology") removed, so industries
// such as "Biotechnology" don't fall into "IT & Software".
export const SECTOR_MAP = [
  { sector: "Pharma & Healthcare", match: ["pharma", "healthcare", "hospital", "drug", "biotech", "diagnostic", "life science"] },
  { sector: "Financials", match: ["bank", "finance", "nbfc", "financial", "insurance", "housing finance", "broking", "asset management"] },
  { sector: "IT & Software", match: ["software", "it -", "it services", "information technology", "computers - software", "consulting"] },
  { sector: "Auto & Ancillaries", match: ["automobile", "auto ancillar", "tyre", "two wheeler", "commercial vehicle", "passenger vehicle"] },
  { sector: "Infra & Realty", match: ["cement", "construction", "infrastructure", "realty", "real estate"] },
  { sector: "Energy & Utilities", match: ["refineries", "oil", "gas", "petroleum", "energy", "power generation", "coal", "utilities"] },
  { sector: "Metals & Mining", match: ["steel", "metal", "mining", "aluminium", "zinc", "copper"] },
  { sector: "Consumer", match: ["fmcg", "consumer", "food", "beverage", "personal product", "retail", "textile", "apparel", "footwear"] },
  { sector: "Chemicals", match: ["chemical", "fertiliser", "fertilizer", "paint", "specialty chemical"] },
  { sector: "Telecom & Media", match: ["telecom", "media", "entertainment", "broadcast"] },
  { sector: "Industrials", match: ["capital goods", "engineering", "electrical equipment", "industrial", "machinery", "defence", "logistics"] },
];

export function sectorKeyFor(industry) {
  if (!industry) return "Uncategorised";
  const s = industry.toLowerCase();
  for (const m of SECTOR_MAP) if (m.match.some((k) => s.includes(k))) return m.sector;
  return industry; // fine-grained industry becomes its own sector
}

/* ============================================================================
   Aggregation (pure)
   ========================================================================== */
const topGuidance = (ledger) => {
  // Skip carried-forward guidance (no_mention) — it's historical, not current.
  const items = (ledger || []).filter(Boolean).filter((g) => g.status !== "no_mention");
  return items.find((g) => g.specificity === "specific") || items[0] || null;
};

function topKeyFigures(sections, n) {
  const fin = (sections || []).find((s) => s.id === "FIN");
  const pool = fin?.key_figures?.length ? fin.key_figures : (sections || []).flatMap((s) => s.key_figures || []);
  return (pool || []).slice(0, n).map((f) => ({ label: f.label, value: f.value, unit: f.unit }));
}

function netDirection(dirs) {
  const c = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  for (const d of dirs) c[d] = (c[d] || 0) + 1;
  if ((c.positive && c.negative) || c.mixed > Math.max(c.positive, c.negative)) return "mixed";
  if (c.positive > c.negative && c.positive >= c.neutral) return "positive";
  if (c.negative > c.positive && c.negative >= c.neutral) return "negative";
  return "neutral";
}

const riskDir = (status) =>
  ({ new: "negative", escalated: "negative", stable: "neutral", easing: "positive", resolved: "positive", no_mention: "neutral" }[status] ||
  "neutral");

const THEME_STOP = new Set(["the", "a", "an", "of", "in", "on", "and", "to", "for", "by", "with"]);
/**
 * Light canonical key so trivial label variants (punctuation, plurals, gerunds,
 * filler words) merge into one theme. NOTE: this is deliberately conservative —
 * word order is preserved and it does NOT do semantic clustering, so synonymous
 * phrasings across companies ("Demand recovery" vs "Recovering demand") still
 * key separately; a shared taxonomy would be the next step. (Over-merging is
 * worse than under-merging here, so we keep it minimal.)
 */
function themeKey(label) {
  return (label || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !THEME_STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * A company's themes across its RETAINED quarters (newest first). Themes that
 * were discussed last quarter but omitted this quarter carry forward (stamped
 * with when they were last mentioned), and a direction change vs the prior
 * mention is flagged (`flip`) so the sector "catches when something flips".
 */
function companyThemeTimeline(comp) {
  const quarters = comp.quarters || [];
  const map = new Map();
  for (const q of quarters) {
    for (const th of q.themes || []) {
      const label = (th.label || "").trim();
      if (!label) continue;
      const k = themeKey(label);
      if (!k) continue;
      if (!map.has(k)) {
        map.set(k, { label, direction: th.direction, note: th.note, date: q.concall_date, section_ref: th.section_ref, _dirs: [th.direction] });
      } else {
        map.get(k)._dirs.push(th.direction); // an older occurrence of the same theme
      }
    }
  }
  for (const v of map.values()) v.flip = v._dirs.length > 1 && v._dirs[0] !== v._dirs[1];
  return map;
}

export function computeSectors(companies) {
  const map = new Map();
  const blank = (key) => ({
    key,
    companies: [],
    guidance: { up: 0, down: 0, flat: 0 },
    themeMap: new Map(),
    cell: {}, // `${ticker}|${themeKey}` -> direction (heatmap)
    risks: [],
    watchRaw: [],
    latest: null,
  });

  for (const comp of Object.values(companies || {})) {
    const q0 = comp.quarters?.[0];
    if (!q0) continue; // only analyzed companies with a tear sheet
    const key = sectorKeyFor(comp.industry);
    if (!map.has(key)) map.set(key, blank(key));
    const sec = map.get(key);

    const guid = topGuidance(q0.guidance_ledger);
    // Themes across the company's retained quarters (carry-forward + flip flags).
    const cthemes = companyThemeTimeline(comp);
    const co = {
      ticker: comp.ticker,
      name: comp.company || comp.ticker,
      industry: comp.industry || null,
      concall_date: q0.concall_date || null,
      source: q0.source || null,
      guidance_headline: guid?.statement || q0.summary || null,
      guidance_direction: guid?.direction || null,
      themes: [...cthemes.values()].map((t) => ({ label: t.label, direction: t.direction, note: t.note })),
      key_figures: topKeyFigures(q0.sections, 2),
    };
    sec.companies.push(co);

    for (const g of q0.guidance_ledger || []) {
      if (g.status === "no_mention") continue; // dropped guidance shouldn't tilt the current distribution
      if (g.direction === "up") sec.guidance.up++;
      else if (g.direction === "down") sec.guidance.down++;
      else if (g.direction === "flat") sec.guidance.flat++;
      if (g.specificity === "specific") {
        // guidance direction is directional, NOT sentiment -> keep the chip neutral
        sec.watchRaw.push({
          kind: "guidance", label: g.metric, dir: "neutral", gdir: g.direction,
          note: g.statement, date: co.concall_date, ticker: co.ticker,
          flip: ["raised", "lowered"].includes(g.status), status: g.status,
        });
      }
    }

    for (const th of cthemes.values()) {
      const tkey = themeKey(th.label);
      if (!sec.themeMap.has(tkey)) sec.themeMap.set(tkey, { label: th.label, companies: [], directions: [], notes: [], last: null, section_ref: th.section_ref });
      const tm = sec.themeMap.get(tkey);
      if (!tm.companies.includes(co.ticker)) tm.companies.push(co.ticker);
      tm.directions.push(th.direction);
      if (th.note) tm.notes.push({ ticker: co.ticker, note: th.note, date: th.date });
      if (th.date && (!tm.last || th.date > tm.last)) tm.last = th.date;
      sec.cell[`${co.ticker}|${tkey}`] = th.direction;
      sec.watchRaw.push({ kind: "theme", label: th.label, dir: th.direction, note: th.note, date: th.date, ticker: co.ticker, flip: th.flip });
    }

    for (const r of q0.risk_register || []) {
      if (r.status === "no_mention") continue;
      sec.risks.push({ ...r, ticker: co.ticker, company: co.name, date: co.concall_date });
      if (["new", "escalated", "easing", "resolved"].includes(r.status)) {
        sec.watchRaw.push({
          kind: "risk", label: r.risk, dir: riskDir(r.status), note: r.note, date: co.concall_date,
          ticker: co.ticker, flip: ["escalated", "easing", "resolved"].includes(r.status), status: r.status,
        });
      }
    }

    if (co.concall_date && (!sec.latest || co.concall_date > sec.latest)) sec.latest = co.concall_date;
  }

  const out = [];
  for (const sec of map.values()) {
    sec.themes = [...sec.themeMap.values()]
      .map((tm) => ({ label: tm.label, companies: tm.companies, net: netDirection(tm.directions), dirs: tm.directions, last: tm.last, notes: tm.notes, section_ref: tm.section_ref, count: tm.companies.length }))
      .sort((a, b) => b.count - a.count || String(b.last || "").localeCompare(String(a.last || "")));
    delete sec.themeMap;

    const eom = sec.latest ? endOfMonth(sec.latest) : null;
    const weeks = eom ? (Date.now() - eom) / (7 * 864e5) : Infinity;
    sec.quiet = weeks > QUIET_WEEKS;
    sec.quietWeeks = isFinite(weeks) ? Math.max(0, Math.floor(weeks)) : null;

    // watch points: newest first; flips (direction changes) bubble up.
    sec.watch = sec.watchRaw
      .sort((a, b) => (b.flip ? 1 : 0) - (a.flip ? 1 : 0) || String(b.date || "").localeCompare(String(a.date || "")))
      .slice(0, 10);
    delete sec.watchRaw;

    // guidance leaning for the mini-distribution
    sec.companies.sort((a, b) => String(b.concall_date || "").localeCompare(String(a.concall_date || "")));
    out.push(sec);
  }
  out.sort((a, b) => b.companies.length - a.companies.length || String(b.latest || "").localeCompare(String(a.latest || "")));
  return out;
}

/* ============================================================================
   Controller + rendering
   ========================================================================== */
const _state = { companies: {}, view: "overview", sector: null, onOpenCompany: null };

export function initSectors({ onOpenCompany } = {}) {
  _state.onOpenCompany = onOpenCompany || null;
}

export function showOverview(companies) {
  if (companies) _state.companies = companies;
  _state.view = "overview";
  _state.sector = null;
  render();
}

export function showDetail(sectorKey, companies) {
  if (companies) _state.companies = companies;
  _state.view = "detail";
  _state.sector = sectorKey;
  render();
}

/** Re-render whatever is currently shown (used by the ~20s poller). */
export function refresh(companies) {
  if (companies) _state.companies = companies;
  render();
}

function render() {
  const sectors = computeSectors(_state.companies);
  if (_state.view === "detail") {
    const sec = sectors.find((s) => s.key === _state.sector);
    if (sec) return renderDetail(sec, sectors.length);
    _state.view = "overview"; // sector vanished -> fall back
  }
  renderOverview(sectors);
}

/* ---- KPI strip (overview) ---- */
function renderSectorKpis(sectors) {
  const kpis = qs("#sectorKpis");
  if (!kpis) return;
  kpis.style.display = "grid";
  const total = sectors.length;
  const mostActive = sectors[0];
  const quiet = sectors.filter((s) => s.quiet).length;

  // dominant theme across all sectors
  const themeCount = new Map();
  for (const s of sectors) for (const t of s.themes) themeCount.set(t.label, (themeCount.get(t.label) || 0) + t.count);
  const dominant = [...themeCount.entries()].sort((a, b) => b[1] - a[1])[0];

  const tile = (cls, label, value, sub, icon) => `
    <div class="kpi ${cls}">
      <div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-ico"><i data-lucide="${icon}"></i></span></div>
      <div class="kpi-value" style="font-size:${String(value).length > 10 ? "20px" : "30px"}">${escapeHtml(String(value))}</div>
      <div class="kpi-delta">${sub}</div>
    </div>`;

  kpis.innerHTML =
    tile("k1", "Sectors Covered", total, `<i data-lucide="layout-grid" class="i16"></i> across tracked names`, "layout-grid") +
    tile("k2", "Most Active Sector", mostActive ? mostActive.key : "—", mostActive ? `<i data-lucide="flame" class="i16"></i> ${mostActive.companies.length} compan${mostActive.companies.length === 1 ? "y" : "ies"}` : "—", "flame") +
    tile("k3", "Dominant Theme", dominant ? dominant[0] : "—", dominant ? `<i data-lucide="hash" class="i16"></i> ${dominant[1]} mention${dominant[1] === 1 ? "" : "s"}` : `<i data-lucide="hash" class="i16"></i> themes appear after refresh`, "sparkles") +
    tile("k4", "Quiet / To Watch", quiet, `<i data-lucide="eye" class="i16"></i> no call in ${QUIET_WEEKS}+ weeks`, "eye");
  refreshIcons();
}

/* ---- Overview: grid of sector cards ---- */
function renderOverview(sectors) {
  renderSectorKpis(sectors);
  const body = qs("#sectorsBody");
  if (!body) return;

  if (!sectors.length) {
    qs("#sectorKpis").style.display = "none";
    body.innerHTML = `
      <div class="card lift"><div class="card-body"><div class="empty">
        <div class="empty-ico"><i data-lucide="layout-grid"></i></div>
        <h4>No sectors yet</h4>
        <p>Analyze a company or two and its sector appears here — with the themes running through it, a guidance read, and carry-forward watch points for the quiet weeks between calls.</p>
        <button class="cta-hint" id="sectorsEmptyCta"><i data-lucide="search" class="i16"></i> Search a company to begin</button>
      </div></div></div>`;
    const cta = qs("#sectorsEmptyCta");
    if (cta) cta.addEventListener("click", () => qs("#searchInput")?.focus());
    refreshIcons();
    return;
  }

  const cards = sectors.map((s, i) => sectorCardHtml(s, i)).join("");
  body.innerHTML = `
    <div class="section-head" style="margin:2px 0 14px">
      <div class="section-title"><span class="dot"></span> Sector Overview</div>
      <span class="badge sector">${sectors.length} sector${sectors.length === 1 ? "" : "s"}</span>
    </div>
    <div class="sector-grid">${cards}</div>
    ${universeSectionHtml(sectors)}`;

  qsa(".sector-card", body).forEach((el) =>
    el.addEventListener("click", () => showDetail(el.getAttribute("data-sector")))
  );
  qsa("[data-open-co]", body).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _state.onOpenCompany?.(el.getAttribute("data-open-co"));
    })
  );
  refreshIcons();
}

/* Consolidated "juice out every summary" section below the sector grid. */
function universeSectionHtml(sectors) {
  const tmap = new Map();
  for (const s of sectors) {
    for (const t of s.themes) {
      const k = t.label.toLowerCase();
      if (!tmap.has(k)) tmap.set(k, { label: t.label, count: 0, dirs: [], sectors: new Set(), last: t.last });
      const e = tmap.get(k);
      e.count += t.count;
      e.dirs.push(...(t.dirs || []));
      e.sectors.add(s.key);
      if (t.last && (!e.last || t.last > e.last)) e.last = t.last;
    }
  }
  const topThemes = [...tmap.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  const themesBody = topThemes.length
    ? `<div class="uni-themes">${topThemes
        .map((t) => {
          const d = dirMeta(netDirection(t.dirs)); // net across ALL sectors, not first-seen
          return `<div class="uni-theme"><span class="theme-chip ${d.cls}"><span class="tc-dot"></span>${escapeHtml(
            t.label
          )}<span class="tc-n">${t.count}</span></span><span class="uni-sectors">${[...t.sectors]
            .slice(0, 2)
            .map(escapeHtml)
            .join(" · ")}</span></div>`;
        })
        .join("")}</div>`
    : `<div class="ts-empty-inline">Themes appear once companies are analyzed — re-run Analyze to extract them.</div>`;

  const allWatch = sectors
    .flatMap((s) => s.watch.map((w) => ({ ...w, sector: s.key })))
    .sort((a, b) => (b.flip ? 1 : 0) - (a.flip ? 1 : 0) || String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 6);
  const watchBody = allWatch.length
    ? allWatch
        .map((w) => {
          const d = dirMeta(w.dir);
          const ico = { theme: "hash", guidance: "compass", risk: "shield-alert" }[w.kind] || "bookmark";
          return `<div class="watch-item ${w.flip ? "flip" : ""}"><span class="watch-kind ${d.cls}"><i data-lucide="${ico}" class="i16"></i></span><div class="watch-body"><div class="watch-top"><span class="watch-label">${escapeHtml(
            w.label
          )}</span>${w.flip ? `<span class="flip-tag"><i data-lucide="zap" class="i16"></i>changed</span>` : ""}</div>${
            w.note ? `<div class="watch-note">${escapeHtml(w.note)}</div>` : ""
          }<div class="watch-meta"><span class="mini-ticker" data-open-co="${escapeHtml(w.ticker)}">${escapeHtml(
            w.ticker
          )}</span><span class="watch-date">${escapeHtml(w.sector)}${w.date ? " · " + fmtDate(w.date) : ""}</span></div></div></div>`;
        })
        .join("")
    : `<div class="ts-empty-inline">Watch points appear as guidance, themes and risks are analyzed.</div>`;

  return `
    <div class="section-head" style="margin:26px 0 14px">
      <div class="section-title"><span class="dot"></span> Across the Universe</div>
      <span class="badge analytics">Consolidated</span>
    </div>
    <div class="universe-grid">
      ${card("Themes Across the Universe", "hash", "var(--grad-cool)", themesBody, "Every summary, juiced into one place")}
      ${card("Latest Watch Points", "eye", "var(--grad-warm)", watchBody, "Most recent across all sectors — changes bubble up")}
    </div>`;
}

function guidanceBarsHtml(g) {
  const total = g.up + g.down + g.flat || 1;
  const seg = (n, cls) => (n ? `<span class="gb ${cls}" style="flex:${n}" title="${n}"></span>` : "");
  return `
    <div class="guide-dist">
      <div class="gd-bar">${seg(g.up, "up")}${seg(g.flat, "flat")}${seg(g.down, "down")}${g.up + g.down + g.flat === 0 ? '<span class="gb none" style="flex:1"></span>' : ""}</div>
      <div class="gd-legend">
        <span class="gd-l up">▲ ${g.up}</span>
        <span class="gd-l flat">▬ ${g.flat}</span>
        <span class="gd-l down">▼ ${g.down}</span>
      </div>
    </div>`;
}

function themeChip(t, small) {
  const d = dirMeta(t.net || t.direction);
  return `<span class="theme-chip ${d.cls} ${small ? "sm" : ""}"><span class="tc-dot"></span>${escapeHtml(t.label)}${
    t.count && !small ? `<span class="tc-n">${t.count}</span>` : ""
  }</span>`;
}

function sectorCardHtml(s, i) {
  const grad = PALETTE[i % PALETTE.length];
  const topThemes = s.themes.slice(0, 3);
  const themeRow = topThemes.length
    ? `<div class="sc-themes">${topThemes.map((t) => themeChip(t)).join("")}</div>`
    : `<div class="sc-themes muted"><i data-lucide="hash" class="i16"></i> Themes appear after the next analysis</div>`;

  const quietBadge = s.quiet
    ? `<span class="watch-badge"><i data-lucide="eye" class="i16"></i> Watch · ${s.quietWeeks ?? "—"}w quiet</span>`
    : "";

  const watchPeek = s.quiet && s.watch.length
    ? `<div class="sc-watch"><i data-lucide="bookmark" class="i16"></i> ${escapeHtml(s.watch[0].label)}${
        s.watch[0].date ? ` · ${fmtDate(s.watch[0].date)}` : ""
      }</div>`
    : "";

  return `
    <div class="sector-card" data-sector="${escapeHtml(s.key)}">
      <div class="sc-top">
        <div class="sc-mark" style="background:linear-gradient(135deg,${grad},${PALETTE[(i + 3) % PALETTE.length]})">
          <i data-lucide="layers"></i>
        </div>
        <div class="sc-titlewrap">
          <div class="sc-title">${escapeHtml(s.key)}</div>
          <div class="sc-sub">${s.companies.length} compan${s.companies.length === 1 ? "y" : "ies"}${
    s.latest ? ` · newest ${fmtDate(s.latest)}` : ""
  }</div>
        </div>
        ${quietBadge}
      </div>
      ${guidanceBarsHtml(s.guidance)}
      ${themeRow}
      ${watchPeek}
      <div class="sc-cta">Open sector <i data-lucide="arrow-right" class="i16"></i></div>
    </div>`;
}

/* ---- Detail ---- */
function renderDetail(sec, sectorCount) {
  const kpis = qs("#sectorKpis");
  if (kpis) kpis.style.display = "none";
  const body = qs("#sectorsBody");
  if (!body) return;

  body.innerHTML =
    detailHeaderHtml(sec) +
    `<div class="sector-detail-grid">
       <div class="sd-main">
         ${companyTableCard(sec)}
         ${runningThemesCard(sec)}
       </div>
       <div class="sd-rail">
         ${watchNowCard(sec)}
         ${riskRegisterCard(sec)}
       </div>
     </div>`;

  qs("#sectorBack")?.addEventListener("click", () => showOverview());
  qsa("[data-open-co]", body).forEach((el) =>
    el.addEventListener("click", () => _state.onOpenCompany?.(el.getAttribute("data-open-co")))
  );
  refreshIcons();
}

function detailHeaderHtml(sec) {
  const g = sec.guidance;
  const lean = g.up === g.down ? "balanced" : g.up > g.down ? "leaning up" : "leaning down";
  const quiet = sec.quiet
    ? `<span class="sh-pill"><i data-lucide="eye" class="i16"></i> Quiet ${sec.quietWeeks}w — watch</span>`
    : `<span class="sh-pill"><i data-lucide="activity" class="i16"></i> Active</span>`;
  return `
    <div class="sector-detail-head">
      <button class="btn ghost sm" id="sectorBack"><i data-lucide="arrow-left" class="i16"></i> All sectors</button>
      <div class="sdh-title">
        <h2>${escapeHtml(sec.key)}</h2>
        <div class="sdh-meta">
          <span class="sh-pill"><i data-lucide="building-2" class="i16"></i> ${sec.companies.length} compan${sec.companies.length === 1 ? "y" : "ies"}</span>
          ${sec.latest ? `<span class="sh-pill"><i data-lucide="calendar" class="i16"></i> newest ${fmtDate(sec.latest)}</span>` : ""}
          <span class="sh-pill"><i data-lucide="scale" class="i16"></i> Guidance ${lean}</span>
          ${quiet}
        </div>
      </div>
    </div>`;
}

function companyTableCard(sec) {
  const rows = sec.companies
    .map((c) => {
      const grad = gradientFor(c.ticker);
      const gd = c.guidance_direction ? GUIDE_DIR[c.guidance_direction] : null;
      const themes = (c.themes || []).slice(0, 2).map((t) => themeChip(t, true)).join("") || `<span class="muted-xs">—</span>`;
      const kf = (c.key_figures || []).map((f) => `<span class="kf-inline">${escapeHtml(f.label)}: <b>${escapeHtml(f.value)}</b>${f.unit ? ` ${escapeHtml(f.unit)}` : ""}</span>`).join("") || `<span class="muted-xs">—</span>`;
      const src = c.source === "ai_summary" ? `<span class="chip src-ai"><i data-lucide="sparkles" class="i16"></i>AI</span>` : c.source === "transcript" ? `<span class="chip src-transcript"><i data-lucide="file-text" class="i16"></i>Transcript</span>` : `<span class="chip src-none">—</span>`;
      return `
        <tr data-open-co="${escapeHtml(c.ticker)}">
          <td>
            <div class="cell-co">
              <div class="co-avatar sm" style="background:${grad}">${escapeHtml(initials(c.name))}</div>
              <div><div class="co-name"><span class="co-name-text">${escapeHtml(c.name)}</span></div><div class="co-ticker">${escapeHtml(c.ticker)}</div></div>
            </div>
          </td>
          <td class="hide-sm mono" style="color:var(--text-3)">${c.concall_date ? fmtDate(c.concall_date) : "—"}</td>
          <td class="hide-sm">${src}</td>
          <td><div class="cell-headline">${c.guidance_headline ? escapeHtml(c.guidance_headline) : '<span class="muted-xs">Awaiting analysis…</span>'}</div>${gd ? `<span class="dirtag ${gd.cls}"><i data-lucide="${gd.icon}" class="i16"></i>${gd.label}</span>` : ""}</td>
          <td class="hide-sm">${themes}</td>
          <td class="hide-md">${kf}</td>
        </tr>`;
    })
    .join("");

  return card(
    "Consolidated View",
    "layout-list",
    "var(--grad-primary)",
    `<div class="table-scroll"><table class="feed-table sector-table">
      <thead><tr><th>Company</th><th class="hide-sm">Concall</th><th class="hide-sm">Source</th><th>Guidance</th><th class="hide-sm">Themes</th><th class="hide-md">Key figures</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    "Every company in the sector · click a row for its tear sheet"
  );
}

function runningThemesCard(sec) {
  if (!sec.themes.length) {
    return card(
      "Running Themes",
      "hash",
      "var(--grad-cool)",
      `<div class="empty" style="min-height:150px"><div class="empty-ico" style="width:56px;height:56px;font-size:22px"><i data-lucide="hash"></i></div>
        <h4 style="font-size:15px">Themes appear after the next analysis</h4>
        <p>Re-run Analyze on this sector's companies to extract the themes running through their calls — then they're tracked here across quarters, with a read-across heatmap.</p></div>`,
      "What's running through the sector — tracked across quarters"
    );
  }

  const list = sec.themes
    .map((t) => {
      const d = dirMeta(t.net);
      const cos = t.companies.map((tk) => `<span class="mini-ticker" data-open-co="${escapeHtml(tk)}">${escapeHtml(tk)}</span>`).join("");
      // Show the note from the most-recent mention (matches t.last), not JSON order.
      const latestNote = (t.notes || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
      const note = latestNote?.note ? `<div class="theme-note">${escapeHtml(latestNote.note)}</div>` : "";
      return `
        <div class="theme-row">
          <div class="theme-row-head">
            <span class="theme-chip ${d.cls}"><span class="tc-dot"></span>${escapeHtml(t.label)}</span>
            <span class="theme-last">${t.last ? fmtDate(t.last) : ""}</span>
          </div>
          ${note}
          <div class="theme-cos">${cos}</div>
        </div>`;
    })
    .join("");

  return card(
    "Running Themes",
    "hash",
    "var(--grad-cool)",
    `${list}${heatmapHtml(sec)}`,
    "What's running through the sector — read across companies"
  );
}

/* Theme × company heatmap — cells colored by direction (the read-across). */
function heatmapHtml(sec) {
  if (sec.companies.length < 1 || sec.themes.length < 1) return "";
  const cols = sec.companies.map((c) => c.ticker);
  const head = `<th class="hm-corner">Theme \\ Co.</th>` + cols.map((t) => `<th class="hm-co">${escapeHtml(t)}</th>`).join("");
  const rows = sec.themes
    .map((t) => {
      const tkey = t.label.toLowerCase();
      const cells = cols
        .map((tk) => {
          const dir = sec.cell[`${tk}|${tkey}`];
          if (!dir) return `<td class="hm-cell empty" title="${escapeHtml(tk)}: not mentioned"></td>`;
          const d = dirMeta(dir);
          return `<td class="hm-cell ${d.cls}" title="${escapeHtml(tk)}: ${d.label}"></td>`;
        })
        .join("");
      return `<tr><td class="hm-theme" title="${escapeHtml(t.label)}">${escapeHtml(t.label)}</td>${cells}</tr>`;
    })
    .join("");
  return `
    <div class="heatmap-wrap">
      <div class="hm-title"><i data-lucide="grid-2x2" class="i16"></i> Read-across heatmap</div>
      <div class="table-scroll"><table class="heatmap"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="hm-legend">${Object.values(DIR).map((d) => `<span class="hm-l"><span class="hm-sw ${d.cls}"></span>${d.label}</span>`).join("")}<span class="hm-l"><span class="hm-sw empty"></span>Not mentioned</span></div>
    </div>`;
}

function watchNowCard(sec) {
  const head = sec.quiet
    ? `Between calls (${sec.quietWeeks}w quiet), these carry forward`
    : "Key points from the most recent calls";
  if (!sec.watch.length) {
    return card(
      "What to Watch Now",
      "eye",
      "var(--grad-warm)",
      `<div class="ts-empty-inline">Watch points appear as guidance, themes and risks are analyzed.</div>`,
      head
    );
  }
  const items = sec.watch
    .map((w) => {
      const d = dirMeta(w.dir);
      const kindIco = { theme: "hash", guidance: "compass", risk: "shield-alert" }[w.kind] || "bookmark";
      return `
        <div class="watch-item ${w.flip ? "flip" : ""}">
          <span class="watch-kind ${d.cls}"><i data-lucide="${kindIco}" class="i16"></i></span>
          <div class="watch-body">
            <div class="watch-top"><span class="watch-label">${escapeHtml(w.label)}</span>${w.flip ? `<span class="flip-tag"><i data-lucide="zap" class="i16"></i>changed</span>` : ""}</div>
            ${w.note ? `<div class="watch-note">${escapeHtml(w.note)}</div>` : ""}
            <div class="watch-meta"><span class="mini-ticker" data-open-co="${escapeHtml(w.ticker)}">${escapeHtml(w.ticker)}</span><span class="watch-date">${w.date ? fmtDate(w.date) : ""}</span></div>
          </div>
        </div>`;
    })
    .join("");
  return card("What to Watch Now", "eye", "var(--grad-warm)", items, head);
}

function riskRegisterCard(sec) {
  if (!sec.risks.length) {
    return card("Sector Risks", "shield-alert", "linear-gradient(135deg,#f43f5e,#f59e0b)", `<div class="ts-empty-inline">No flagged risks in the sector yet.</div>`, "Aggregated across the sector");
  }
  // group by status
  const order = ["new", "escalated", "stable", "easing", "resolved"];
  const byStatus = {};
  for (const r of sec.risks) (byStatus[r.status] = byStatus[r.status] || []).push(r);
  const statusMeta = {
    new: ["gl-down", "New"], escalated: ["gl-down", "Escalated"], stable: ["gl-warn", "Stable"], easing: ["gl-up", "Easing"], resolved: ["gl-up", "Resolved"],
  };
  const blocks = order
    .filter((st) => byStatus[st]?.length)
    .map((st) => {
      const [cls, label] = statusMeta[st];
      const items = byStatus[st]
        .map((r) => `<div class="risk-item"><span class="mini-ticker" data-open-co="${escapeHtml(r.ticker)}">${escapeHtml(r.ticker)}</span><div class="risk-body"><div class="risk-name">${escapeHtml(r.risk)}</div>${r.note ? `<div class="risk-note">${escapeHtml(r.note)}</div>` : ""}</div></div>`)
        .join("");
      return `<div class="risk-group"><div class="risk-group-head"><span class="chip ${cls}"><span class="cdot"></span>${label}</span></div>${items}</div>`;
    })
    .join("");
  return card("Sector Risks", "shield-alert", "linear-gradient(135deg,#f43f5e,#f59e0b)", blocks, "Aggregated across the sector · click a ticker for its tear sheet");
}

/* ---- shared card shell (matches the existing .card look) ---- */
function card(title, icon, iconBg, bodyHtml, sub) {
  return `
    <div class="card lift sector-block">
      <div class="card-head">
        <div>
          <h3><span class="card-ico" style="background:${iconBg}"><i data-lucide="${icon}" class="i16"></i></span>${escapeHtml(title)}</h3>
          ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
        </div>
      </div>
      <div class="card-body">${bodyHtml}</div>
    </div>`;
}
