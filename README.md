# Daksham Capital · Concall Tracker

A colorful, premium web dashboard for tracking Indian companies' earnings-call
("concall") analysis. An analyst searches for any listed company, clicks
**Analyze**, and within a few minutes a one-page **tear sheet** of that
company's *latest* earnings concall appears on the dashboard — downloadable as a
colorful PDF. Once analyzed, a company stays **tracked** and auto-refreshes every
quarter, so the board grows into a live tracker across companies and sectors
("guidance vs delivery", sector themes).

> **Status: Step 2 — Analysis engine live.** On top of the Step 1 foundation
> (scaffold, visual shell, live search), Analyze now works **end-to-end**: a
> GitHub Actions pipeline logs into Screener, fetches a company's latest concall
> AI summary (transcript-PDF fallback), classifies it with OpenAI into the fixed
> 11-section tear sheet + guidance/risk ledgers, commits the JSON, and the
> dashboard renders it live. See [Build roadmap](#build-roadmap) and
> [The analysis pipeline](#the-analysis-pipeline).

---

## What works today

- 🔎 **Live company search** — type in the header search bar and get a live
  dropdown of real companies (India-first), backed by the Muns stock-search API
  proxied through the Worker so the token never reaches the browser.
- ✨ **Analyze plumbing** — select a company, enter the shared passcode, and the
  Worker tracks it + dispatches the analysis workflow. Degrades gracefully with
  a friendly message when secrets aren't set yet.
- 📊 **The dashboard shell** — KPI strip, live-feed board with colored status
  chips, sector-coverage donut, the 11-section framework preview, and a
  gorgeous tear-sheet placeholder — every empty state designed, never blank.
- 📄 **PDF export** — a basic working export of the tear sheet.

---

## Architecture

A **static site served by a Cloudflare Worker** — a proven, no-build-step
pattern:

```
Browser
  │  (types in search / clicks Analyze)
  ▼
Cloudflare Worker  (worker/index.js)
  ├─ /api/search   → proxies Muns API, injects MUNS_TOKEN (server-side)
  ├─ /api/analyze  → passcode gate → GitHub Contents API (track) → dispatch
  └─ everything else → serves ./public via the ASSETS binding
        │
        ▼
   public/  (HTML + CSS + vanilla JS, no build)
   public/data/*.json  ← the app's memory (the dashboard reads ONLY these)
        ▲
        │  commits JSON back
   GitHub Actions  (.github/workflows/analyze.yml)  ← heavy work (later steps)
        │
        ▼
   Cloudflare auto-deploys on push
```

Key principles:

- **No build step.** Plain HTML, CSS, and vanilla JS (ES modules). Libraries
  (Tailwind, Google Fonts, Lucide, ECharts, jsPDF, html2canvas) load via CDN
  with graceful fallbacks if a CDN is blocked.
- **Committed JSON is the source of truth.** The dashboard reads only
  `public/data/*.json`. Nothing is fetched from a database at runtime.
- **Heavy work runs in GitHub Actions** and commits JSON back to the repo;
  Cloudflare auto-deploys on push. (Step 1 ships only a stub workflow.)
- **Secrets never touch the client.** The Worker holds all tokens and reads
  them from its environment.

### Files

| Path | Purpose |
| --- | --- |
| `wrangler.jsonc` | Cloudflare Worker config (name, assets → `./public`, `ASSETS` binding). |
| `worker/index.js` | The Worker: `/api/search`, `/api/analyze`, static fallback. |
| `public/index.html` | The Daksham shell. |
| `public/css/styles.css` | Design system — **all colours in CSS variables** for easy rebranding. |
| `public/js/app.js` | All front-end logic. |
| `public/js/ui.js` | Small UI helpers. |
| `public/data/tracked.json` | Companies being tracked. |
| `public/data/tearsheets.json` | Per-company tear-sheet data (empty for now). |
| `public/data/jobs.json` | Analyze job status: `queued \| running \| done \| failed`. |
| `public/data/metadata.json` | `updated_at`, `count`. |
| `.github/workflows/analyze.yml` | **Stub** analyze pipeline (filled in Step 2/3). |

---

## The search API

The browser calls the Worker; the Worker proxies to Muns and adds the token:

**Browser → Worker**

```http
POST /api/search
Content-Type: application/json

{ "query": "reliance" }
```

**Worker → Muns** (token injected server-side)

```http
POST https://birdnest.muns.io/stock/search
accept: */*
Authorization: Bearer <MUNS_TOKEN>
Content-Type: application/json

{ "query": "reliance", "user_index": 124 }
```

> `user_index` is **always** exactly `124` (static). `query` is the typed text.

**Response shape** (results is an object keyed by ticker; value is
`[country, company_name, industry]`):

```json
{
  "data": {
    "total_results": 10,
    "results": {
      "RELIANCE": ["India", "Reliance Industries Ltd", "Refineries & Marketing"],
      "RCOM": ["India", "Reliance Communications Ltd", "Telecom - Cellular & Fixed line services"]
    }
  },
  "message": "",
  "success": true
}
```

The UI renders these as a dropdown — company name (bold), a monospace ticker
pill, the industry (muted, handles `null`), and a country tag — with India
results first, keyboard navigation, and click-to-select.

---

## Secrets / environment

**Nothing is hardcoded.** Set these where indicated. Search works with only
`MUNS_TOKEN`; if the GitHub vars / passcode aren't set, Analyze degrades
gracefully with a friendly message and never breaks the page.

### Cloudflare Worker env vars

Set in the Cloudflare dashboard (**Workers & Pages → your Worker → Settings →
Variables and Secrets**) or via `wrangler secret put <NAME>`:

| Variable | Needed for | Description |
| --- | --- | --- |
| `MUNS_TOKEN` | **Search (now)** | Bearer token for the Muns stock-search API. |
| `GITHUB_TOKEN` | Analyze | Fine-grained PAT for **this** repo: **Contents** read/write + **Actions** read/write. |
| `GITHUB_REPO` | Analyze | `owner/repo` (e.g. `ceekay-munshot/dakshamconcall`). |
| `GITHUB_BRANCH` | Analyze | Branch to read/commit data on (e.g. `main`). |
| `ANALYZE_PASSCODE` | Analyze | Shared passcode that gates the Analyze action. |

### GitHub Actions secrets (used by the analyze pipeline)

Set in **Repo → Settings → Secrets and variables → Actions**:

| Secret | Required | Description |
| --- | --- | --- |
| `SCREENER_EMAIL` | yes | Screener.in login email. |
| `SCREENER_PASSWORD` | yes | Screener.in login password. |
| `OPENAI_API_KEY` | yes | Powers the 11-section classifier. |
| `FIRECRAWL_API_KEY` | recommended | Fallback fetch for pages/PDFs that block direct access (exchange PDFs). |
| `OPENAI_MODEL` | optional | The single pinned model. Defaults to `gpt-4o`; swappable (temperature 0). |

The pipeline commits results back with the built-in Actions token
(`permissions: contents: write`) — no extra token needed inside the workflow.

---

## Local development

```bash
npm install -g wrangler          # if you don't have it
wrangler dev                     # serves the site + Worker locally
```

Provide local secrets for `wrangler dev` in a `.dev.vars` file (git-ignored):

```
MUNS_TOKEN=your-token-here
# ANALYZE_PASSCODE=...
# GITHUB_TOKEN=...
# GITHUB_REPO=owner/repo
# GITHUB_BRANCH=main
```

## Deploy (Cloudflare Workers)

```bash
wrangler deploy
```

Then set the production secrets (see the table above) in the Cloudflare
dashboard. Because the site is committed to the repo, once CI is connected
Cloudflare **auto-deploys on every push** — later steps just commit JSON and the
dashboard updates itself.

---

## Design notes

- **Premium, colorful, glassy** — a soft light background with a layered
  multi-color gradient mesh (violet / indigo / blue / teal / pink), glassy
  translucent cards, generous rounded corners, soft shadows, and tasteful
  gradient accents. Deliberately **not** a dark "intelligence terminal."
- **Every colour is a CSS variable** in `:root` (`public/css/styles.css`) — swap
  the `--brand-*` / `--grad-*` tokens to rebrand in one place.
- **3-zone iframe shell** — sticky header, a single scrolling content area, and
  a slim footer. The page shell never scrolls; it looks great embedded at
  `width: 100%` / `height: 100vh`.
- Fonts: **Space Grotesk** (display), **Inter** (body), **JetBrains Mono**
  (tickers/numbers). Charts via **ECharts** with one cohesive palette.

---

## The analysis pipeline

Runs in GitHub Actions (`.github/workflows/analyze.yml`) and commits JSON back
to the branch Cloudflare deploys. The **AI organizes, it does not opine** — we
reformat Screener's trusted summary into our schema and keep Screener's own Key
Takeaways verbatim. One pinned model, temperature 0, a fixed strict JSON schema:
same input → same structure every quarter.

| File (`screener-test/`) | Role |
| --- | --- |
| `analyze-company.mjs` | Orchestrator: take a `TICKER` (or refresh all tracked), run the flow, update the JSON stores, commit with a conflict-proof push loop. |
| `scrape-screener.mjs` | Screener login + fetch the latest concall AI summary (transcript-PDF fallback via authenticated fetch → Firecrawl). Defensive: saves screenshots + DOM samples to artifacts on trouble. |
| `classify.mjs` | OpenAI Structured-Outputs classifier into the 11 sections + the deterministic guidance-vs-delivery diff. |
| `llm.mjs` | Thin OpenAI (`json_schema`, temp 0, pinned model) + Firecrawl clients. |

**Run it:** Actions tab → *Analyze Concall* → Run workflow → enter a ticker
(e.g. `RELIANCE`). Or click **Analyze** in the dashboard. Leave the ticker blank
(or wait for the daily schedule) to refresh stale tracked companies.

## Build roadmap

- ✅ **Step 1 — Foundation:** scaffold + working live search + the visual shell.
- ✅ **Step 2 — Analyze pipeline (`analyze.yml`):** Screener login → latest
  concall AI summary (transcript-PDF fallback); commit + `jobs.json` states.
- ✅ **Step 3 — AI classification:** organize the summary into the fixed
  11-section tear sheet (single pinned model, temperature 0, strict schema).
- ✅ **Step 4 — Guidance-vs-delivery ledger** + a risk register across quarters
  (deltas computed deterministically from the prior quarter).
- **Step 5 — Sector rollups** + a between-quarter "watch" view.
- **Step 6 — Rich colorful PDF report** (a basic export works today).

### The fixed 11-section framework

Every tear sheet renders the same sections, in the same order, quarter to
quarter:

1. Financial Performance
2. Order Book & Demand
3. Segment & Product Performance
4. Product & Technology
5. Manufacturing & Capacity
6. Geography & Distribution
7. Supply Chain & Operations
8. Market & Customer Strategy
9. Strategic Initiatives & M&A
10. Risks & External Factors
11. Guidance & Outlook

Plus **Key Takeaways**, **Pressing Questions**, and a **Guidance vs Delivery**
band.
