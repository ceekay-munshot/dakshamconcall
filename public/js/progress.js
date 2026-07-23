/**
 * progress.js — global analyze-progress manager + floating panel.
 * ==============================================================================
 * A delightful, on-brand progress experience for every Analyze run that is
 * DECOUPLED from the current view:
 *   - active jobs are persisted to localStorage,
 *   - a SINGLE poller reads public/data/jobs.json (+ tearsheets.json) every ~11s,
 *   - switching tabs never interrupts a run (the dock is a fixed, app-level
 *     element, not part of any view),
 *   - a full reload recovers in-progress jobs and resumes the animation,
 *   - multiple concurrent runs stack as separate cards.
 *
 * The stepper is anchored to REAL state: `queued`/`running` advance on an
 * estimated timeline anchored to the job's real start; `done`/`failed` come
 * straight from jobs.json (and the tear sheet's presence). No fake "done".
 *
 * app.js supplies the data + actions via initProgress({ refresh, getJob,
 * getSheet, onViewReport, onRetry }). This module owns the poll loop.
 */
import { qs, escapeHtml, refreshIcons, initials } from "./ui.js";

const LS_KEY = "daksham.activeJobs.v2";
const POLL_MS = 11000;

/* The six client-facing stages + a friendly line for each. */
const STAGES = [
  { key: "queued", label: "Queued", line: "Queued — waiting for a runner…" },
  { key: "login", label: "Login", line: "Logging into Screener…" },
  { key: "fetch", label: "Fetch", line: "Fetching the concall summary…" },
  { key: "analyse", label: "Analyse", line: "Analysing the 11 sections…" },
  { key: "compile", label: "Compile", line: "Compiling the tear sheet…" },
  { key: "done", label: "Done", line: "Tear sheet ready." },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
// Seconds since real "running" start at which each middle stage begins. A single
// company runs ~90-160s once the runner is live; the bar keeps creeping until
// the REAL "done" flips it to 100 (so we never show done early).
const STAGE_AT = { login: 3, fetch: 15, analyse: 40, compile: 85 };
const EST_TOTAL = 130; // s, for the continuous bar while running

let cbs = {};
let jobs = []; // { ticker, name, startedAt, status, stage, done, failMsg, concallDate, dismissed }
let timer = null;

/* ------------------------------------------------------------------ boot --- */
export function initProgress(callbacks) {
  cbs = callbacks || {};
  ensureDock();
  jobs = loadLS().map((j) => ({ ...j, _mountAt: Date.now() }));
  if (jobs.length) {
    render();
    ensurePolling();
  }
}

/** Called by app.js the moment an Analyze is successfully queued. */
export function registerJob(company) {
  const t = (company.ticker || "").toUpperCase();
  if (!t) return;
  const now = Date.now();
  // Snapshot the CURRENT output stamps so a re-analysis of an already-tracked
  // name waits for NEW output rather than instantly resolving to the old one.
  const sheet0 = cbs.getSheet?.(t) || null;
  const job0 = cbs.getJob?.(t) || null;
  const base = {
    ticker: t,
    name: company.name || t,
    startedAt: now,
    status: "queued",
    stage: "queued",
    done: false,
    failMsg: null,
    concallDate: null,
    dismissed: false,
    baseGen: sheet0?.quarters?.[0]?.generated_at || null,
    baseFin: job0?.finished_at || null,
  };
  const existing = jobs.find((j) => j.ticker === t);
  if (existing) Object.assign(existing, base);
  else jobs.push(base);
  saveLS();
  render();
  ensurePolling();
  // Nudge the dock into view on a fresh run.
  qs("#progressDock")?.classList.add("has-jobs");
}

/* --------------------------------------------------------------- polling --- */
function ensurePolling() {
  if (timer) return;
  tick();
  timer = setInterval(tick, POLL_MS);
}
function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick() {
  // Pull the latest committed JSON + re-render the board first, so a freshly
  // "done" company lands on the board at the same moment its card completes.
  try {
    await cbs.refresh?.();
  } catch {
    /* keep animating on a transient fetch error */
  }

  for (const j of jobs) {
    if (j.dismissed || j.done || j.status === "failed") continue;
    const rec = cbs.getJob?.(j.ticker) || null;
    const sheet = cbs.getSheet?.(j.ticker) || null;
    const q0 = sheet?.quarters?.[0] || null;
    const realStart = rec?.started_at ? Date.parse(rec.started_at) : j.startedAt;

    // Completion/failure only count when the output is DEMONSTRABLY NEW vs the
    // baseline captured at registration — so re-analysing a name never resolves
    // to its previous (stale) tear sheet or old job record.
    const genAt = q0?.generated_at || null;
    const finAt = rec?.finished_at || null;
    const freshDone =
      (genAt && genAt !== j.baseGen) ||
      (rec?.status === "done" && finAt && finAt !== j.baseFin);
    const freshFail = rec?.status === "failed" && finAt && finAt !== j.baseFin;

    if (freshFail) {
      j.status = "failed";
      j.stage = "failed";
      j.failMsg = rec.message || rec.error || "The run failed. Please try again.";
    } else if (freshDone) {
      j.status = "done";
      j.stage = "done";
      j.done = true;
      j.doneAt = Date.now();
      j.concallDate = q0?.concall_date || null;
    } else if (rec?.status === "running") {
      j.status = "running";
      j.stage = estimateStage(realStart);
    } else {
      // Seeded "queued", or an old record with no fresh output yet — hold.
      j.status = "queued";
      j.stage = "queued";
    }
  }
  saveLS();
  render();

  if (!jobs.some((j) => !j.dismissed && j.status !== "done" && j.status !== "failed")) {
    stopPolling();
  }
}

function estimateStage(realStartMs) {
  const s = (Date.now() - realStartMs) / 1000;
  if (s >= STAGE_AT.compile) return "compile";
  if (s >= STAGE_AT.analyse) return "analyse";
  if (s >= STAGE_AT.fetch) return "fetch";
  return "login";
}

/** Continuous 0-100 for the bar (real done = 100; running creeps, capped 92). */
function progressPct(j) {
  if (j.status === "done") return 100;
  if (j.status === "failed") return 100;
  if (j.status === "queued") return 7;
  const realStart = cbs.getJob?.(j.ticker)?.started_at
    ? Date.parse(cbs.getJob(j.ticker).started_at)
    : j.startedAt;
  const frac = Math.min(1, Math.max(0, (Date.now() - realStart) / 1000 / EST_TOTAL));
  return Math.round(18 + 74 * frac); // 18 → 92 while running
}

/* ---------------------------------------------------------------- render --- */
function ensureDock() {
  if (qs("#progressDock")) return;
  const dock = document.createElement("div");
  dock.id = "progressDock";
  dock.className = "progress-dock";
  dock.setAttribute("aria-live", "polite");
  document.body.appendChild(dock);
}

function render() {
  const dock = qs("#progressDock");
  if (!dock) return;
  const visible = jobs.filter((j) => !j.dismissed);
  dock.classList.toggle("has-jobs", visible.length > 0);
  dock.innerHTML = visible.map(cardHtml).join("");

  visible.forEach((j) => {
    const el = dock.querySelector(`[data-ticker="${cssEsc(j.ticker)}"]`);
    if (!el) return;
    el.querySelector(".prog-x")?.addEventListener("click", () => dismiss(j.ticker));
    el.querySelector(".prog-view")?.addEventListener("click", () => {
      cbs.onViewReport?.(j.ticker);
    });
    el.querySelector(".prog-retry")?.addEventListener("click", () => {
      cbs.onRetry?.({ ticker: j.ticker, name: j.name });
    });
  });
  refreshIcons();
}

function cardHtml(j) {
  const stateCls =
    j.status === "done" ? "is-done" : j.status === "failed" ? "is-failed" : "is-running";
  const activeIdx = j.status === "failed" ? -1 : STAGE_INDEX[j.stage] ?? 0;
  const line =
    j.status === "failed"
      ? escapeHtml(j.failMsg || "The run failed. Please try again.")
      : (STAGES[activeIdx] || STAGES[0]).line;
  const pct = progressPct(j);

  const steps = STAGES.map((s, i) => {
    let cls = "prog-step";
    if (j.status === "failed") cls += i === 0 ? " is-active" : "";
    else if (i < activeIdx || j.status === "done") cls += " is-complete";
    else if (i === activeIdx) cls += " is-active";
    return `<div class="${cls}" title="${escapeHtml(s.line)}">
        <span class="prog-dot"><i data-lucide="check" class="i10"></i></span>
        <span class="prog-slabel">${escapeHtml(s.label)}</span>
      </div>`;
  }).join("");

  let actions = "";
  if (j.status === "done")
    actions = `<button class="prog-btn prog-view"><i data-lucide="file-text" class="i16"></i> View Report</button>`;
  else if (j.status === "failed")
    actions = `<button class="prog-btn prog-retry"><i data-lucide="rotate-cw" class="i16"></i> Retry</button>`;

  return `
    <div class="prog-card ${stateCls}" data-ticker="${escapeHtml(j.ticker)}">
      <div class="prog-head">
        <span class="prog-avatar">${escapeHtml(initials(j.name))}</span>
        <div class="prog-id">
          <div class="prog-name" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</div>
          <div class="prog-line">${line}</div>
        </div>
        <button class="prog-x" aria-label="Dismiss"><i data-lucide="x" class="i16"></i></button>
      </div>
      <div class="prog-track"><div class="prog-fill" style="width:${pct}%"></div></div>
      <div class="prog-steps">${steps}</div>
      ${actions ? `<div class="prog-actions">${actions}</div>` : ""}
    </div>`;
}

function dismiss(ticker) {
  const j = jobs.find((x) => x.ticker === ticker);
  if (j) j.dismissed = true;
  jobs = jobs.filter((x) => !x.dismissed);
  saveLS();
  render();
  if (!jobs.some((x) => x.status !== "done" && x.status !== "failed")) stopPolling();
}

/* ------------------------------------------------------------- storage ----- */
function loadLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    // Only recover jobs that were still in flight (or recently done) — drop very
    // old entries so the dock doesn't resurrect week-old runs.
    const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
    return Array.isArray(arr)
      ? arr.filter((j) => j && j.ticker && (j.startedAt || 0) > cutoff && !j.dismissed)
      : [];
  } catch {
    return [];
  }
}
function saveLS() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(jobs.filter((j) => !j.dismissed)));
  } catch {
    /* storage may be unavailable (private mode) — the dock still works in-memory */
  }
}

const cssEsc = (s) => String(s).replace(/["\\]/g, "\\$&");
