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
PRs #21 (editor pass + real dates) and #22 (BPCL scraper fix) are **both merged to
`main`**. RELIANCE was validated live (run on the review branch, 2026-07-27) — see
below. Current work continues on branch
**`claude/daksham-concall-tracker-handoff-pm9vc1`** (restart from `main` after each
merge, same as before).

1. **Editor pass validated on RELIANCE — works, but the first pass lost data.**
   The editor did its job: prose 85→25 points, "Product & Technology" re-filed into
   "Segment & Product Performance" by meaning, **all 22 figures preserved**, no
   errors; new P&L rows (EBITDA/PAT growth, margins) captured. BUT the **first-pass
   extraction** (gpt-4o, upstream of the editor) dropped ~11 real **Jio operational
   KPIs** vs the prior run (27→22 figs): 5G users 285m, ARPU 215.6, home-broadband
   28.6m, AirFiber 14m, usage, patents 4,500, RCPL rev 8,600. **Client directive:
   do NOT lose data — keep the fullest qualitative detail; a little repetition is
   fine; strip repeats ONLY.** Fix applied in `classify.mjs` (this branch):
   (a) first-pass `SYSTEM_PROMPT` now says **capture EVERY number of ANY kind** —
   the financial/operational lists are explicitly ILLUSTRATIVE examples, **not a
   closed checklist** (an example list must never become a filter that drops an
   unlisted metric); (b) new **consolidated-vs-standalone** rule: when the source
   gives both for the same metric, keep **consolidated only**; use standalone only
   when no consolidated is given; (c) `EDITOR_SYSTEM` rewritten **conservative** —
   the only thing it strips is repetition (a near-verbatim duplicate, or prose that
   only restates a table figure); keep on any doubt. **NEXT: re-run RELIANCE** and
   confirm the Jio KPIs return (figs back toward 27) and prose stays complete. Kill
   switch still `TEARSHEET_EDITOR=0`.
2. **Displayed-quarter date still month-default.** `preciseConcallDate()` works —
   the 3 history quarters now show real days (2026-04-24, 2026-01-16, 2025-10-17,
   from transcripts). But the **latest** quarter uses the AI summary, which lacks
   the call date, so it stays `2026-07-01`. TODO: for `ai_summary` latest quarters,
   also read the day from the latest **transcript PDF** as a date-only source.
3. **BPCL re-run still pending.** The RELIANCE run already proved PR #22's direct
   `/concalls/summary/<id>/` fetch works live (12,694 chars). Still worth a BPCL
   dispatch to formally confirm; it draws 1 metered summary view.
4. **Screener free-tier quota.** The free account gets **10 concall AI-summary
   views / 30 days** — the `/concalls/summary/<id>/` endpoint is metered. Our data
   is **10 summaries + 59 free BSE transcript PDFs**; the transcript fallback is
   what covers all ~20 companies. PR #22 fetches the *metered* endpoint, so it
   draws down the 10/month. BPCL's latest call is **audio-only (no transcript)**, so
   its latest quarter can ONLY come from the metered endpoint. Decide: transcript
   fallback where possible, or move `SCREENER_EMAIL` to Screener Premium.

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
