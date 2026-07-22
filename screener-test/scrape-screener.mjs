/**
 * scrape-screener.mjs — log into Screener.in and fetch a company's latest
 * concall analysis. PREFERS Screener's AI concall summary (already sectioned,
 * with Key Takeaways + highlighted questions); FALLS BACK to the transcript PDF.
 *
 * This is the riskiest part of the pipeline. The live DOM must be discovered
 * against the real site, so this module is deliberately DEFENSIVE:
 *   - multiple path/selector strategies,
 *   - on any trouble it saves a screenshot + a DOM sample to the artifacts dir
 *     and returns a structured { error } instead of crashing,
 *   - heavy logging so the workflow logs explain what happened.
 *
 * Returns (per company):
 *   { ticker, company, concall_date, source, source_url, raw_text,
 *     screener_sections, key_takeaways[], pressing_questions[], history[] }
 * or { ticker, error }.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { firecrawlScrape } from "./llm.mjs";

const BASE = "https://www.screener.in";
const ARTIFACTS = process.env.ARTIFACTS_DIR || "screener-test/output";
const MAX_TEXT = 26000; // cap chars sent downstream to control tokens

const log = (...a) => console.log("[scrape]", ...a);
const warn = (...a) => console.warn("[scrape]", ...a);

function ensureArtifacts() {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
  } catch {}
}
function saveArtifact(name, content) {
  try {
    ensureArtifacts();
    fs.writeFileSync(path.join(ARTIFACTS, name), content);
    log("saved artifact", name);
  } catch (e) {
    warn("could not save artifact", name, e.message);
  }
}
async function saveShot(page, name) {
  try {
    ensureArtifacts();
    await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage: true });
    log("saved screenshot", name);
  } catch (e) {
    warn("could not screenshot", name, e.message);
  }
}

/* ============================================================================
   Browser + login
   ========================================================================== */
export async function launchAndLogin() {
  const email = process.env.SCREENER_EMAIL;
  const password = process.env.SCREENER_PASSWORD;
  if (!email || !password) throw new Error("SCREENER_EMAIL / SCREENER_PASSWORD not set");

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();

  log("logging in…");
  await page.goto(`${BASE}/login/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="username"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click('button[type="submit"], input[type="submit"]').catch(() => page.press('input[name="password"]', "Enter")),
  ]);
  await page.waitForTimeout(2500);

  const loggedIn = await page.locator('a[href*="logout"]').count().catch(() => 0);
  if (!loggedIn) {
    await saveShot(page, "login-failed.png");
    saveArtifact("login-failed.html", await page.content().catch(() => ""));
    throw new Error("Screener login failed (no logout link found)");
  }
  log("login OK");
  return { browser, context, page };
}

/* ============================================================================
   Resolve + open the company page
   ========================================================================== */
async function resolveCompanyUrl(context, ticker) {
  // 1) Try the direct slugs first (fast path).
  const candidates = [`${BASE}/company/${ticker}/consolidated/`, `${BASE}/company/${ticker}/`];
  for (const url of candidates) {
    try {
      const res = await context.request.get(url, { timeout: 30000 });
      if (res.ok()) return url;
    } catch {}
  }
  // 2) Fall back to Screener's search API to find the correct slug.
  try {
    const res = await context.request.get(`${BASE}/api/company/search/?q=${encodeURIComponent(ticker)}`, {
      headers: { accept: "application/json" },
      timeout: 30000,
    });
    if (res.ok()) {
      const list = await res.json();
      if (Array.isArray(list) && list[0]?.url) {
        const url = list[0].url.startsWith("http") ? list[0].url : BASE + list[0].url;
        // prefer consolidated variant if it exists
        return url.replace(/\/$/, "/") ;
      }
    }
  } catch {}
  return null;
}

async function openCompany(page, context, ticker) {
  const url = await resolveCompanyUrl(context, ticker);
  if (!url) throw new Error(`Could not resolve a Screener page for ${ticker}`);
  log("opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  // Company display name (multiple fallbacks).
  const company =
    (await page.locator("h1").first().textContent().catch(() => null))?.trim() ||
    (await page.title().catch(() => ""))?.split("|")[0]?.trim() ||
    ticker;

  return { url, company };
}

/* ============================================================================
   Find the Concalls list on the company page
   ========================================================================== */
/**
 * Returns { entries:[{ date, links:[{text,href,tag}] }], domSample } newest-first.
 * Uses several strategies and always captures a DOM sample for discovery.
 */
async function findConcalls(page, ticker) {
  // Try to scroll the Documents/Concalls area into view (Screener lazy-renders).
  await page.evaluate(() => {
    const el =
      document.querySelector("#documents") ||
      [...document.querySelectorAll("h2,h3")].find((h) => /concall/i.test(h.textContent || ""));
    if (el) el.scrollIntoView();
  }).catch(() => {});
  await page.waitForTimeout(800);

  const data = await page.evaluate(() => {
    // Locate the Concalls container by heading text or class.
    function findContainer() {
      const byClass = document.querySelector(".concalls");
      if (byClass) return byClass;
      const heads = [...document.querySelectorAll("h1,h2,h3,h4,.title,.sub")];
      const h = heads.find((el) => /concall/i.test(el.textContent || ""));
      if (h) {
        // climb to a container that holds link rows
        let node = h;
        for (let i = 0; i < 4 && node; i++) {
          node = node.parentElement;
          if (node && node.querySelector("a")) return node;
        }
        return h.parentElement || h;
      }
      return document.querySelector("#documents") || null;
    }
    const container = findContainer();
    if (!container) return { entries: [], domSample: "" };

    const rows = [...container.querySelectorAll("li, tr, .flex")].filter((r) =>
      r.querySelector("a, button")
    );
    const seen = new Set();
    const entries = [];
    for (const r of rows) {
      const text = (r.textContent || "").replace(/\s+/g, " ").trim();
      // A concall row usually starts with a Month Year date.
      const dm = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i);
      const links = [...r.querySelectorAll("a, button")].map((a) => ({
        text: (a.textContent || "").replace(/\s+/g, " ").trim(),
        href: a.getAttribute("href") || "",
        tag: a.tagName.toLowerCase(),
      }));
      if (!links.length) continue;
      const key = (dm ? dm[0] : "") + "|" + links.map((l) => l.href || l.text).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ date: dm ? dm[0] : null, links, rowText: text.slice(0, 200) });
    }
    return { entries, domSample: container.outerHTML.slice(0, 20000) };
  });

  // Always capture the concalls DOM for discovery / debugging.
  saveArtifact(`concalls-${ticker}.html`, data.domSample || "(empty)");
  log(`found ${data.entries.length} concall-ish rows for ${ticker}`);

  // Echo discovery info into the job logs so selectors can be refined without
  // downloading the artifact zip (the live DOM is what we iterate against).
  data.entries.slice(0, 4).forEach((e, i) => {
    log(`  row[${i}] date=${e.date} :: ` + e.links.map((l) => `[${l.tag}] "${l.text}" -> ${l.href}`).join("  |  "));
  });
  if (!data.entries.length) {
    log("CONCALLS DOM SAMPLE (first 3500 chars):\n" + (data.domSample || "").slice(0, 3500));
  }
  return data;
}

/* ============================================================================
   Extract the AI summary (preferred) for a concall entry
   ========================================================================== */
function categorize(links) {
  const pick = (re) => links.find((l) => re.test(l.text) || re.test(l.href));
  return {
    transcript: pick(/transcript/i),
    ppt: pick(/ppt|present/i),
    notes: pick(/notes/i),
    summary: pick(/summary/i),
    rec: pick(/\brec\b|audio/i),
  };
}

/** Split a block of summary text into { heading, text } sections + takeaways/questions. */
function parseSummaryText(fullText) {
  const text = (fullText || "").replace(/\r/g, "").trim();
  const lines = text.split("\n").map((l) => l.trim());
  const sections = [];
  let cur = { heading: "Summary", text: "" };
  const takeaways = [];
  const questions = [];
  let mode = "body";
  for (const line of lines) {
    if (!line) continue;
    const isHeading = /^[A-Z][A-Za-z0-9 &/'-]{2,60}:?$/.test(line) && line.split(" ").length <= 8 && !/[.!?]$/.test(line);
    if (/key takeaways/i.test(line)) {
      if (cur.text.trim()) sections.push(cur);
      cur = { heading: "Key Takeaways", text: "" };
      mode = "takeaways";
      continue;
    }
    if (/(pressing|highlighted|analyst).*questions|^questions:?$/i.test(line)) {
      if (cur.text.trim()) sections.push(cur);
      cur = { heading: "Questions", text: "" };
      mode = "questions";
      continue;
    }
    if (isHeading) {
      if (cur.text.trim()) sections.push(cur);
      cur = { heading: line.replace(/:$/, ""), text: "" };
      mode = "body";
      continue;
    }
    if (mode === "takeaways") takeaways.push(line.replace(/^[-•*]\s*/, ""));
    else if (mode === "questions") questions.push(line.replace(/^[-•*]\s*/, ""));
    else cur.text += line + "\n";
  }
  if (cur.text.trim() || cur.heading) sections.push(cur);
  return { sections, takeaways, questions };
}

/**
 * Try to obtain the AI summary for the latest concall. Multiple strategies;
 * returns { raw_text, screener_sections, key_takeaways, pressing_questions, source_url } or null.
 */
async function extractAiSummary(page, context, entry, companyUrl) {
  const cat = categorize(entry.links);

  // Strategy A: a Screener-hosted "summary"/"notes" link -> open + read it.
  const hosted = [cat.summary, cat.notes].find(
    (l) => l && (l.href.startsWith("/") || l.href.includes("screener.in"))
  );
  if (hosted) {
    const url = hosted.href.startsWith("http") ? hosted.href : BASE + hosted.href;
    try {
      const sub = await context.newPage();
      await sub.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sub.waitForTimeout(1000);
      const txt = await sub.evaluate(() => {
        const main = document.querySelector("main, article, .card, #main, .container") || document.body;
        return (main.innerText || "").trim();
      });
      await sub.close();
      if (txt && txt.length > 300) {
        const parsed = parseSummaryText(txt);
        log("AI summary via hosted link", url);
        return finishSummary(txt, parsed, url);
      }
    } catch (e) {
      warn("hosted summary fetch failed", e.message);
    }
  }

  // Strategy B: summary rendered inline on the company page (look for "Key Takeaways").
  try {
    const inline = await page.evaluate(() => {
      const marker = [...document.querySelectorAll("h1,h2,h3,h4,strong,b,p,div")].find((el) =>
        /key takeaways/i.test(el.textContent || "")
      );
      if (!marker) return null;
      // climb to a reasonably large container
      let node = marker;
      for (let i = 0; i < 5 && node?.parentElement; i++) node = node.parentElement;
      return (node?.innerText || "").trim();
    });
    if (inline && inline.length > 300) {
      const parsed = parseSummaryText(inline);
      log("AI summary via inline block");
      return finishSummary(inline, parsed, companyUrl);
    }
  } catch (e) {
    warn("inline summary scan failed", e.message);
  }

  return null;
}

function finishSummary(rawText, parsed, url) {
  const bodySections = parsed.sections.filter(
    (s) => !/key takeaways|questions/i.test(s.heading)
  );
  return {
    raw_text: rawText.slice(0, MAX_TEXT),
    screener_sections: bodySections.map((s) => ({ heading: s.heading, text: s.text.trim() })),
    key_takeaways: parsed.takeaways,
    pressing_questions: parsed.questions,
    source: "ai_summary",
    source_url: url,
  };
}

/* ============================================================================
   Fallback: transcript PDF -> text
   ========================================================================== */
async function fetchPdfText(context, url) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  const referer = /bseindia/i.test(host)
    ? "https://www.bseindia.com/"
    : /nseindia/i.test(host)
    ? "https://www.nseindia.com/"
    : BASE + "/";

  // NSE needs a cookie warm-up before it will serve attachments.
  if (/nseindia/i.test(host)) {
    try {
      await context.request.get("https://www.nseindia.com/", { timeout: 30000 });
    } catch {}
  }

  // 1) Authenticated fetch with a per-host Referer.
  try {
    const res = await context.request.get(url, {
      headers: {
        Referer: referer,
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "application/pdf,*/*",
      },
      timeout: 60000,
    });
    if (res.ok()) {
      const buf = await res.body();
      const text = await pdfToText(buf);
      if (text && text.length > 200) return { text, via: "direct" };
    } else {
      warn("pdf direct fetch status", res.status());
    }
  } catch (e) {
    warn("pdf direct fetch failed", e.message);
  }

  // 2) Firecrawl fallback (parses the PDF for us).
  const fc = await firecrawlScrape(url);
  if (fc.ok && fc.text) return { text: fc.text.slice(0, MAX_TEXT), via: "firecrawl" };

  return null;
}

async function pdfToText(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    let out = "";
    const max = Math.min(doc.numPages, 40);
    for (let i = 1; i <= max; i++) {
      const pageObj = await doc.getPage(i);
      const content = await pageObj.getTextContent();
      out += content.items.map((it) => it.str).join(" ") + "\n";
      if (out.length > MAX_TEXT) break;
    }
    return out.slice(0, MAX_TEXT);
  } catch (e) {
    warn("pdfjs extract failed", e.message);
    return "";
  }
}

async function extractTranscript(context, entry) {
  const cat = categorize(entry.links);
  if (!cat.transcript) return null;
  const url = cat.transcript.href.startsWith("http") ? cat.transcript.href : BASE + cat.transcript.href;
  log("transcript fallback:", url);
  const res = await fetchPdfText(context, url);
  if (!res) return null;
  return {
    raw_text: res.text,
    screener_sections: [],
    key_takeaways: [],
    pressing_questions: [],
    source: "transcript",
    source_url: url,
  };
}

/* ============================================================================
   Public: scrape one company
   ========================================================================== */
function toIsoDate(monthYear) {
  if (!monthYear) return null;
  const d = new Date(monthYear + " 01");
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {string} ticker
 * @param {{maxHistory?:number}} opts
 */
export async function scrapeCompany(page, context, ticker, opts = {}) {
  const maxHistory = opts.maxHistory ?? 4;
  try {
    const { url, company } = await openCompany(page, context, ticker);
    const { entries } = await findConcalls(page, ticker);

    if (!entries.length) {
      await saveShot(page, `no-concalls-${ticker}.png`);
      return { ticker, error: "No concall rows found on the company page." };
    }

    // Newest first is how Screener lists them; take the latest with links.
    const latest = entries[0];

    let summary = await extractAiSummary(page, context, latest, url);
    if (!summary) summary = await extractTranscript(context, latest);
    if (!summary) {
      await saveShot(page, `no-summary-${ticker}.png`);
      return { ticker, error: "Found concalls but could not extract an AI summary or transcript." };
    }

    // Best-effort history (older quarters) for guidance-vs-delivery comparison.
    const history = [];
    for (let i = 1; i < Math.min(entries.length, maxHistory); i++) {
      try {
        let h = await extractTranscript(context, entries[i]); // history via transcript is fine
        if (h) {
          history.push({
            concall_date: toIsoDate(entries[i].date),
            ...h,
            company,
            ticker,
          });
        }
      } catch (e) {
        warn("history quarter failed", e.message);
      }
    }

    return {
      ticker,
      company,
      concall_date: toIsoDate(latest.date),
      source: summary.source,
      source_url: summary.source_url,
      raw_text: summary.raw_text,
      screener_sections: summary.screener_sections,
      key_takeaways: summary.key_takeaways,
      pressing_questions: summary.pressing_questions,
      history,
    };
  } catch (err) {
    warn("scrapeCompany error", err.message);
    await saveShot(page, `error-${ticker}.png`).catch(() => {});
    return { ticker, error: err.message || String(err) };
  }
}
