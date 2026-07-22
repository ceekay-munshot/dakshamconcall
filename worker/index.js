/**
 * Daksham Capital · Concall Tracker — Cloudflare Worker
 * =====================================================
 * One Worker, two responsibilities:
 *
 *   1. Static site:  every non-/api request is served from ./public via the
 *      ASSETS binding (see wrangler.jsonc). No build step.
 *
 *   2. Dynamic API:
 *        POST /api/search   — proxy the Muns stock-search API, injecting the
 *                             MUNS_TOKEN server-side so it never reaches the
 *                             browser. (WORKS in Step 1.)
 *        POST /api/analyze  — passcode-gated "track + dispatch" plumbing:
 *                             append the company to tracked.json, mark a queued
 *                             job in jobs.json, and dispatch the analyze.yml
 *                             workflow. (Plumbing WORKS in Step 1; the workflow
 *                             itself is a stub until Prompt 2.)
 *
 * Secrets are read from `env` — nothing is ever hardcoded. Search needs only
 * MUNS_TOKEN. If the GitHub vars / passcode are missing, /api/analyze responds
 * with a friendly, structured message instead of breaking the page.
 */

// --- Constants ---------------------------------------------------------------

// Upstream stock-search endpoint. `user_index` is ALWAYS 124 (static).
const MUNS_SEARCH_URL = "https://birdnest.muns.io/stock/search";
const MUNS_USER_INDEX = 124;

// GitHub REST API base + the data files the Worker reads/writes.
const GITHUB_API = "https://api.github.com";
const TRACKED_PATH = "public/data/tracked.json";
const JOBS_PATH = "public/data/jobs.json";
const ANALYZE_WORKFLOW = "analyze.yml";

// --- Small helpers -----------------------------------------------------------

/** JSON response with permissive CORS (handy if the site is ever embedded). */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...extraHeaders,
    },
  });
}

/** Base64 helpers that are safe for UTF-8 JSON payloads. */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function b64decode(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Standard headers for GitHub REST calls (a User-Agent is mandatory). */
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "daksham-concall-tracker",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

// --- /api/search -------------------------------------------------------------

/**
 * Proxy the browser's search query to the Muns API, adding the bearer token.
 * Body in:  { query: string }
 * Body out: the upstream JSON (shape: { data: { results: {...} }, ... }).
 */
async function handleSearch(request, env) {
  if (!env.MUNS_TOKEN) {
    return json(
      {
        success: false,
        error: "search_unconfigured",
        message:
          "Search is not configured yet. Set the MUNS_TOKEN secret on the Worker to enable live company search.",
      },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body." }, 400);
  }

  const query = (body?.query ?? "").toString().trim();
  if (query.length < 2) {
    // Mirror an empty-but-valid upstream response so the client stays simple.
    return json({ data: { total_results: 0, results: {} }, success: true });
  }

  try {
    const upstream = await fetch(MUNS_SEARCH_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: `Bearer ${env.MUNS_TOKEN}`,
        "Content-Type": "application/json",
      },
      // user_index is always exactly 124.
      body: JSON.stringify({ query, user_index: MUNS_USER_INDEX }),
    });

    if (!upstream.ok) {
      return json(
        {
          success: false,
          error: "upstream_error",
          message: `Search service returned ${upstream.status}. Please try again.`,
        },
        502
      );
    }

    const data = await upstream.json();
    return json(data, 200);
  } catch (err) {
    return json(
      {
        success: false,
        error: "search_failed",
        message: "Could not reach the search service. Please try again.",
      },
      502
    );
  }
}

// --- /api/analyze ------------------------------------------------------------

/** Read a JSON file from the repo via the Contents API. Returns { json, sha }. */
async function ghReadJson(env, owner, repo, path, branch) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
    branch
  )}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) {
    throw new Error(`GitHub read ${path} failed: ${res.status}`);
  }
  const payload = await res.json();
  const content = b64decode(payload.content || "");
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  return { json: parsed, sha: payload.sha };
}

/** Commit a JSON file back to the repo via the Contents API (create/update). */
async function ghWriteJson(env, owner, repo, path, branch, obj, sha, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message,
    content: b64encode(JSON.stringify(obj, null, 2) + "\n"),
    branch,
  };
  if (sha) body.sha = sha; // required when updating an existing file
  const res = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub write ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Fire the analyze.yml workflow via workflow_dispatch. */
async function ghDispatchWorkflow(env, owner, repo, branch, inputs) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${ANALYZE_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env),
    body: JSON.stringify({ ref: branch, inputs }),
  });
  // 204 No Content == success.
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`Workflow dispatch failed: ${res.status} ${text}`);
  }
}

/**
 * Track a company + dispatch its analysis.
 * Body in: { ticker, name, industry, country, passcode }
 *
 * Steps (mirrors an "add item then trigger" pattern):
 *   1. Validate passcode against ANALYZE_PASSCODE.
 *   2. Append the company to tracked.json (if new) and commit.
 *   3. Mark jobs.json[ticker] = { status: "queued", queued_at }.
 *   4. Dispatch analyze.yml with the ticker.
 * Returns { ok, queued } — or a friendly message if not yet configured.
 */
async function handleAnalyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body." }, 400);
  }

  const ticker = (body?.ticker ?? "").toString().trim().toUpperCase();
  const name = (body?.name ?? "").toString().trim();
  const industry = (body?.industry ?? null) || null;
  const country = (body?.country ?? null) || null;
  const passcode = (body?.passcode ?? "").toString();

  if (!ticker || !name) {
    return json(
      { ok: false, message: "Please select a company before analyzing." },
      400
    );
  }

  // --- Graceful degradation: not wired up yet --------------------------------
  // If the passcode isn't configured on the Worker, analysis can't be gated —
  // tell the user kindly instead of pretending to queue.
  if (!env.ANALYZE_PASSCODE) {
    return json({
      ok: false,
      configured: false,
      reason: "no_passcode",
      message:
        "Analyze isn't switched on yet. An admin needs to set the ANALYZE_PASSCODE secret on the Worker.",
    });
  }

  // 1) Passcode gate.
  if (passcode !== env.ANALYZE_PASSCODE) {
    return json(
      {
        ok: false,
        reason: "bad_passcode",
        message: "That passcode doesn't match. Please check with your admin.",
      },
      401
    );
  }

  // GitHub write access is required to persist the queue + dispatch the job.
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.GITHUB_BRANCH) {
    return json({
      ok: false,
      configured: false,
      reason: "no_github",
      message:
        "Analyze is passcode-verified, but the GitHub pipeline isn't configured yet (GITHUB_TOKEN / GITHUB_REPO / GITHUB_BRANCH). Ask an admin to finish setup.",
    });
  }

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const branch = env.GITHUB_BRANCH;
  if (!owner || !repo) {
    return json(
      { ok: false, message: "GITHUB_REPO must look like 'owner/repo'." },
      500
    );
  }

  const nowIso = new Date().toISOString();

  try {
    // 2) tracked.json — append the company if it isn't already tracked.
    const tracked = await ghReadJson(env, owner, repo, TRACKED_PATH, branch);
    const trackedJson = tracked.json || { companies: [], updated_at: null };
    if (!Array.isArray(trackedJson.companies)) trackedJson.companies = [];

    const already = trackedJson.companies.some(
      (c) => (c.ticker || "").toUpperCase() === ticker
    );
    if (!already) {
      trackedJson.companies.push({
        ticker,
        name,
        industry,
        country,
        added_at: nowIso,
        concall_date: null, // filled by the pipeline (Prompt 2/3)
        source: null, // "ai_summary" | "transcript"
        guidance_headline: null,
      });
      trackedJson.updated_at = nowIso;
      await ghWriteJson(
        env,
        owner,
        repo,
        TRACKED_PATH,
        branch,
        trackedJson,
        tracked.sha,
        `track: add ${ticker} (${name})`
      );
    }

    // 3) jobs.json — mark this ticker as queued.
    const jobs = await ghReadJson(env, owner, repo, JOBS_PATH, branch);
    const jobsJson = jobs.json || { jobs: {} };
    if (!jobsJson.jobs || typeof jobsJson.jobs !== "object") jobsJson.jobs = {};
    jobsJson.jobs[ticker] = {
      status: "queued",
      queued_at: nowIso,
      name,
      industry,
      country,
    };
    await ghWriteJson(
      env,
      owner,
      repo,
      JOBS_PATH,
      branch,
      jobsJson,
      jobs.sha,
      `queue: analyze ${ticker}`
    );

    // 4) Dispatch the workflow (stub in Step 1, real work later).
    // Pass the search-API industry as a backfill (the scraper value is primary).
    await ghDispatchWorkflow(env, owner, repo, branch, {
      ticker,
      industry: industry || "",
    });

    return json({
      ok: true,
      queued: true,
      ticker,
      name,
      queued_at: nowIso,
      message: `Queued analysis for ${name}. This usually takes a few minutes.`,
    });
  } catch (err) {
    // Never leak internals; give the user something actionable.
    return json(
      {
        ok: false,
        reason: "pipeline_error",
        message:
          "Couldn't queue the analysis right now. Please try again in a moment.",
        detail: (err && err.message) || String(err),
      },
      502
    );
  }
}

// --- Router ------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight for the API routes.
    if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return json({}, 204);
    }

    if (pathname === "/api/search") {
      if (request.method !== "POST") {
        return json({ success: false, message: "Use POST." }, 405);
      }
      return handleSearch(request, env);
    }

    if (pathname === "/api/analyze") {
      if (request.method !== "POST") {
        return json({ ok: false, message: "Use POST." }, 405);
      }
      return handleAnalyze(request, env);
    }

    // Lightweight health check — handy for uptime pings.
    if (pathname === "/api/health") {
      return json({
        ok: true,
        service: "daksham-concall-tracker",
        search_configured: Boolean(env.MUNS_TOKEN),
        analyze_configured: Boolean(
          env.ANALYZE_PASSCODE &&
            env.GITHUB_TOKEN &&
            env.GITHUB_REPO &&
            env.GITHUB_BRANCH
        ),
      });
    }

    // Unknown API route.
    if (pathname.startsWith("/api/")) {
      return json({ success: false, message: "Not found." }, 404);
    }

    // Everything else -> static assets (index.html, css, js, data JSON…).
    return env.ASSETS.fetch(request);
  },
};
