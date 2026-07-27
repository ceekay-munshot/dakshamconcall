# Daksham Concall Tracker — Project Context & Handoff

> Read this first, then continue the work. It captures everything a fresh session
> needs: what the project is, how it's built, what's shipped, what's pending, and
> the gotchas. (Living doc — update the "Open items" section as work lands.)

## What this is
A premium web dashboard tracking Indian companies' earnings-call ("concall")
analysis. **Munshot** is building it for client **Daksham Capital** (contact:
Amit). Guiding principle throughout: **"AI organizes, it does NOT opine"** — we
reorganize Screener's concall AI summaries into a fixed format; we don't add
opinions of our own.

## Architecture (important: NO build step)
- **Cloudflare Worker** (`worker/index.js`) serves static `./public` + `/api/*`
  via the ASSETS binding. Deploy = Cloudflare auto-uploads `public/` on every
  push to `main`. There is no bundler/build, so the Cloudflare "build" is
  effectively a no-op that goes green unless something is structurally broken.
- **Pipeline** (`screener-test/*.mjs`, run by `.github/workflows/analyze.yml`):
  logs into Screener → scrapes a company's concall AI summary → OpenAI Structured
  Outputs classifies it into a fixed 11-section schema → commits the JSON back to
  the repo. Cloudflare then redeploys.
- **Data store** (committed JSON): `public/data/{tracked,tearsheets,jobs,metadata}.json`.
  `tearsheets.json` is the main one (per-company, up to 4 quarters each).
- **Frontend**: plain `public/index.html` + `public/css/styles.css` + vanilla
  ES-module JS in `public/js/`:
  - `app.js` — dashboard, tear-sheet modal, search, analyze flow
  - `report.js` — PDF export **and** shared helpers (`quarterMatrix`,
    `metricKey`, `normPeriod`, `explainerSubsections`, `figureText`)
  - `sectors.js` — sector overview + detail (momentum, insights, heatmap)
  - `progress.js` — global analyze-progress dock + centered focus modal
  - `export-xlsx.js` — branded Excel/CSV export
  - `ui.js` — shared utils (`escapeHtml`, `fmtDate`, icons)
  - CDN libs only (jsPDF, html2canvas, ExcelJS, echarts, lucide). No framework.
- **Universe**: ~20 Indian companies, mostly Auto & Ancillaries + Reliance,
  Infosys, Devyani, CESC, UltraTech, BPCL.

## Git workflow (follow exactly)
- Designated branch: **`claude/daksham-concall-tracker-foundation-moa0xi`**.
  Develop here; never push elsewhere.
- Squash-merge PRs with `(#N)` in the title. **After each merge, restart the
  branch from main**:
  `git fetch origin main && git checkout -B claude/daksham-concall-tracker-foundation-moa0xi origin/main`.
- The remote branch keeps its pre-squash commits after a merge (already-merged
  history), so the next push needs **`git push --force-with-lease`**. That's safe
  when the remote holds only already-merged commits — verify first with
  `git log origin/main..origin/<branch>`.
- A stop-hook flags commits whose committer isn't `noreply@anthropic.com` as
  "Unverified". This is a **false positive** for GitHub's squash-merge commits
  and for the user's own commits — **never amend already-merged or someone
  else's commits.** Local git identity is already `noreply@anthropic.com` / `Claude`.
- Do NOT put the model identifier in commits/PRs/code.

## What's already shipped (all merged to `main`)
**Frontend client-feedback round (PR #20):**
- Redundancy: `explainerSubsections()` in `report.js` drops verbatim
  cross-section repeats (lossless — identical text only). Used by tear sheet,
  PDF and Excel. "Reported" tag hidden; always-on "AI summary" pill removed.
- Key figures: `normPeriod()` → house style **"1Q FY27"**. The 4-call matrix
  (`quarterMatrix()`) is a **trend** view (metrics reported in ≥2 calls, fullest
  first) with a note for the one-offs (which stay in the single-call view).
- **Sector Insights** (`sectors.js` `sectorInsights()`/`sectorInsightsCard()`):
  where the sector **agrees**, where it **splits**, **leaders vs laggards**, and
  **what to watch** — from stated theme directions + risks. Generic keyword
  "axes" (`INSIGHT_AXES`) align cross-labeled topics ("Commodity inflation" ≡
  "Raw-material cost pressure").
- UI: analyze progress pops up **centered** (backgroundable) via `progress.js`
  focus mode; "Show more" ↔ "Show less" toggle.

**Pipeline (PR #21 — merged, but needs a validation run to see its effect):**
- `editTearSheet()` in `classify.mjs`: a **second "governing editor" LLM call**
  over the latest quarter that curates prose ONLY — drops table-figure
  restatements, cross-section repeats and filler; fixes logic errors; re-files
  each point by MEANING; ranks most-important-first. **Safe by construction:**
  the editor never returns `key_figures` — they're re-attached from the first
  pass, so no number can be lost; any error returns the first-pass sections
  unchanged. Runs on the latest quarter only. Gated by env **`TEARSHEET_EDITOR`**
  (set `0` to disable instantly).
- First-pass prompt strengthened: capture EBITDA margin/growth & PAT growth as
  their own rows; classify by meaning not keyword; prose is the "why", not a
  restated number.
- `preciseConcallDate()` in `scrape-screener.mjs`: real call day from the text,
  guarded to the listing month (rejects stray body dates). `mergeQuarters()`
  dedups by month so the date upgrade never creates a duplicate quarter.

## Open items / what's next (start here)
1. **PR #22 (BPCL scraper fix) — OPEN, merge + verify.** BPCL failed because its
   latest call is audio-only (no transcript PDF) and the AI-summary button loads
   an async modal we read too early. Fix: read the button's
   `data-url="/concalls/summary/<id>/"` and fetch that endpoint directly (with
   `X-Requested-With: XMLHttpRequest`), first, before the click path. Additive
   with fallback (can't regress working companies). **Merge it, then re-run BPCL**
   through the analyze workflow to confirm (endpoint needs Screener auth → CI only).
2. **Validate the editor pass (PR #21) on ONE company** before it reprocesses
   everything: trigger the analyze workflow on RELIANCE or UltraTech, eyeball the
   tear sheet (tighter prose, no restated numbers, every figure intact, real
   date), then tune the editor prompt in `classify.mjs` if it's too aggressive or
   not enough. Kill switch: `TEARSHEET_EDITOR=0`.
3. **Screener free-tier quota.** The free account gets **10 concall AI-summary
   views / 30 days** — the `/concalls/summary/<id>/` endpoint is metered. Our data
   is **10 summaries + 59 free BSE transcript PDFs**; the transcript fallback is
   what covers all ~20 companies. PR #22 fetches the *metered* endpoint, so it
   draws down the 10/month. Decide: add a **transcript fallback for BPCL** when
   the summary quota is exhausted, or move the `SCREENER_EMAIL` account to
   Screener Premium.

## Client's north-star (from the 41-min review)
Reverse-engineering / "deselection": keep everything but ruthlessly remove
**repetition** (a figure in the table must not be restated in the prose below
it), fix logic errors, classify by MEANING, rank most-important-first.
**NOT a hard 2-page cap** — don't lose data, just kill repetition. Source is
**always** the Screener AI summary (transcript is a free fallback for data, not a
content source the client asked for). Use the user's **exact** Munshot logo
(`public/assets/munshot-logo.png`) — never a recreation.

## How to verify frontend changes (no deploy needed)
Headless Playwright harness pattern: serve `public/` with
`python3 -m http.server`, launch the pre-installed
`chromium_headless_shell` with the proxy args + `--proxy-bypass-list`, stub the
CDN libs and `/api/*` with `page.route`, drive the UI, assert on the DOM and take
a screenshot. Syntax-check JS with `node --check <file>`. Pipeline functions are
pure enough to unit-test with a mocked `openaiStructured` (set a fake
`OPENAI_API_KEY` and stub `global.fetch`).
