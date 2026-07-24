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
// Generous cap so short AI summaries are NEVER truncated (they're a few KB);
// only very long transcript PDFs would ever hit this. The display handles
// compactness — we preserve the full source for the classifier.
const MAX_TEXT = 80000;

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

  const uField = 'input[name="username"], input[type="email"], #id_username';
  const pField = 'input[name="password"], input[type="password"], #id_password';
  await page.fill(uField, email).catch(() => {});
  await page.fill(pField, password).catch(() => {});

  // Submit, then wait for the redirect away from /login/ (best-effort).
  await Promise.all([
    page.waitForURL((u) => !/\/login\//.test(u.toString()), { timeout: 15000 }).catch(() => {}),
    (async () => {
      const btn = page
        .locator('button[type="submit"], input[type="submit"], button:has-text("Login")')
        .first();
      if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
      else await page.press(pField, "Enter").catch(() => {});
    })(),
  ]);
  await page.waitForTimeout(1500);

  // Robust success detection. Screener's logout control is not always a plain
  // <a href*="logout"> (it can be a form POST / behind an account menu), so the
  // PRIMARY signal is: the password form is gone AND we're no longer on /login/.
  const finalUrl = page.url();
  const stillOnLogin = /\/login\//.test(finalUrl);
  const passwordLeft = await page.locator(pField).count().catch(() => 0);
  const logout = await page
    .locator('a[href*="logout"], form[action*="logout"], button:has-text("Logout"), a:has-text("Logout")')
    .count()
    .catch(() => 0);
  const loggedIn = logout > 0 || (!stillOnLogin && passwordLeft === 0);

  log(
    `login check: url=${finalUrl} onLogin=${stillOnLogin} pwFields=${passwordLeft} logout=${logout} -> ${
      loggedIn ? "OK" : "FAIL"
    }`
  );

  if (!loggedIn) {
    await saveShot(page, "login-failed.png");
    saveArtifact("login-failed.html", await page.content().catch(() => ""));
    // Surface any inline error (e.g. wrong credentials) into the job logs.
    const bodyText = await page
      .evaluate(() => (document.body.innerText || "").slice(0, 1200))
      .catch(() => "");
    log("LOGIN PAGE TEXT (first 1200 chars):\n" + bodyText);
    throw new Error("Screener login failed (form still present / no logout link)");
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

/**
 * Best-effort INDUSTRY/SECTOR capture from the Screener company page. Screener
 * shows the industry as a peer-comparison link near the ratios/peers area. This
 * is defensive (multiple strategies) and LOGS its candidates so the exact DOM
 * can be refined from the run logs; analyze-company backfills from env when null.
 */
async function extractIndustry(page) {
  try {
    const res = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const candidates = [];
      // 1) Explicit "Industry:" / "Sector:" label text (most reliable).
      const bodyText = norm(document.body.innerText).slice(0, 8000);
      for (const label of ["Industry", "Sector"]) {
        const m = bodyText.match(
          new RegExp(label + "\\s*[:\\-]\\s*([A-Za-z][A-Za-z0-9 &/,'()\\-]{2,60})")
        );
        if (m) candidates.push({ src: label.toLowerCase() + "-label", value: norm(m[1]) });
      }
      // 2) Peer-comparison links usually carry the industry name.
      for (const a of document.querySelectorAll('a[href*="/company/compare/"]')) {
        const t = norm(a.textContent);
        if (t && t.length >= 3 && t.length <= 60 && !/compare|peers|view|more|add/i.test(t))
          candidates.push({ src: "compare-link", value: t });
      }
      // 3) Sector/market classification links.
      for (const a of document.querySelectorAll('a[href*="/market/"]')) {
        const t = norm(a.textContent);
        if (t && t.length >= 3 && t.length <= 60) candidates.push({ src: "market-link", value: t });
      }
      return candidates.slice(0, 12);
    });
    log("industry candidates: " + JSON.stringify(res));
    // Screener's market-classification breadcrumb runs BROAD -> SPECIFIC
    // (macro-sector -> sector -> industry -> basic industry). Prefer the most
    // specific classification link (the LAST market-link) so we store e.g.
    // "Refineries & Marketing" rather than the generic "Energy", and
    // "Computers - Software & Consulting" rather than "Information Technology".
    // Both map to the same broad sector in the UI, but the specific label is far
    // more informative on the tear sheet. Explicit "Industry:"/compare labels,
    // when present, are already specific and take precedence.
    const marketLinks = res.filter((c) => c.src === "market-link");
    const pick =
      res.find((c) => c.src.endsWith("-label")) ||
      res.find((c) => c.src === "compare-link") ||
      marketLinks[marketLinks.length - 1] ||
      null;
    return pick ? pick.value : null;
  } catch (e) {
    warn("industry extract failed", e.message);
    return null;
  }
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

  const industry = await extractIndustry(page);
  log(`industry for ${ticker}: ${industry || "(not found — will backfill from env/tracked)"}`);

  return { url, company, industry };
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
    if (/^\s*(key takeaways|key highlights|takeaways|highlights)\s*:?\s*$/i.test(line) || /key takeaways/i.test(line)) {
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

/** Open a concall entry's Screener-hosted summary/notes link and read it.
 *  Reusable for BOTH the latest quarter and prior quarters (history). */
async function fetchHostedSummary(context, entry) {
  const cat = categorize(entry.links);
  const hosted = [cat.summary, cat.notes].find(
    (l) => l && (l.href.startsWith("/") || l.href.includes("screener.in"))
  );
  if (!hosted) return null;
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
      return finishSummary(txt, parsed, url);
    }
  } catch (e) {
    warn("hosted summary fetch failed", e.message);
  }
  return null;
}

/**
 * Try to obtain the AI summary for the latest concall. Multiple strategies;
 * returns { raw_text, screener_sections, key_takeaways, pressing_questions, source_url } or null.
 */
async function extractAiSummary(page, context, entry, companyUrl) {
  const cat = categorize(entry.links);

  // Strategy A0: Screener's AI concall summary opens from a BUTTON (no href).
  // Click it to reveal the content, then read the modal / expanded block.
  if (cat.summary && cat.summary.tag === "button") {
    try {
      const btn = page
        .locator('button:has-text("AI Summary"), button:has-text("Summary")')
        .first();
      if (await btn.count().catch(() => 0)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2200);
        log("clicked AI Summary button");
      }
    } catch (e) {
      warn("AI Summary click failed", e.message);
    }
    // If a modal/dialog opened, read it directly.
    try {
      const modalText = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '[role="dialog"], dialog[open], .modal, .modal-content, .popup, .drawer, .ReactModal__Content'
          ),
        ];
        const best = nodes
          .map((n) => (n.innerText || "").trim())
          .filter((t) => t.length > 300 && t.length < 40000)
          .sort((a, b) => b.length - a.length)[0];
        return best || null;
      });
      if (modalText && /key takeaways|guidance|revenue|margin|ebitda/i.test(modalText)) {
        const parsed = parseSummaryText(modalText);
        log("AI summary via modal");
        return finishSummary(modalText, parsed, companyUrl);
      }
    } catch (e) {
      warn("modal summary read failed", e.message);
    }
  }

  // Strategy A: a Screener-hosted "summary"/"notes" link -> open + read it.
  const hostedResult = await fetchHostedSummary(context, entry);
  if (hostedResult) {
    log("AI summary via hosted link");
    return hostedResult;
  }

  // Strategy B: summary rendered inline on the company page. Anchor on the LEAF
  // element whose OWN text says "Key Takeaways" (i.e. the heading itself), then
  // climb only to a bounded summary container — never the whole page (otherwise
  // navigation, financial tables and unrelated concalls leak into the classifier).
  try {
    const inline = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll("h1,h2,h3,h4,h5,strong,b,summary,span,p,li,div"),
      ];
      const leaf = candidates
        .filter((el) => {
          const own = [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(" ");
          return /key takeaways/i.test(own);
        })
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
      if (!leaf) return null;
      // climb to a reasonably-sized (bounded) summary section
      let node = leaf;
      for (let i = 0; i < 4; i++) {
        const parent = node.parentElement;
        if (!parent || parent.tagName === "BODY" || parent.tagName === "HTML") break;
        node = parent;
        const len = (node.innerText || "").length;
        if (len > 400 && len < 20000) break;
      }
      const text = (node.innerText || "").trim();
      return text.length > 22000 ? null : text; // reject a whole-page grab
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

const MONTH_NUM = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Extract the ACTUAL day-level concall date from text (the call happened on a
 * specific day, e.g. 17 July — not the 1st, which is all the "Mon YYYY" listing
 * row gives). GUARD: only accept a date whose month+year matches the concall's
 * listing month (`monthIso`), so we grab the real call date and never a stray
 * date from the body (a guidance horizon, a prior-year comparison, etc.). The
 * date sits near the top of a filing/summary, so the scan is bounded. Returns an
 * ISO date or null (caller then keeps the month-level fallback).
 */
function preciseConcallDate(text, monthIso) {
  if (!text || !monthIso) return null;
  const want = { y: +monthIso.slice(0, 4), m: +monthIso.slice(5, 7) };
  const hay = String(text).slice(0, 6000);
  const hits = [];
  let m;
  // "17 July 2026" / "17th July 2026"
  const re1 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{4})\b/gi;
  while ((m = re1.exec(hay))) hits.push({ d: +m[1], mo: MONTH_NUM[m[2].toLowerCase()], y: +m[3] });
  // "July 17, 2026"
  const re2 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/gi;
  while ((m = re2.exec(hay))) hits.push({ d: +m[2], mo: MONTH_NUM[m[1].toLowerCase()], y: +m[3] });
  // "17-07-2026" / "17/07/2026" / "17.07.2026"
  const re3 = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  while ((m = re3.exec(hay))) hits.push({ d: +m[1], mo: +m[2], y: +m[3] });
  // "2026-07-17"
  const re4 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = re4.exec(hay))) hits.push({ d: +m[3], mo: +m[2], y: +m[1] });

  const pick = hits.find(
    (h) => h.mo === want.m && h.y === want.y && h.d >= 1 && h.d <= 31
  );
  if (!pick) return null;
  return `${pick.y}-${String(pick.mo).padStart(2, "0")}-${String(pick.d).padStart(2, "0")}`;
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
    const { url, company, industry } = await openCompany(page, context, ticker);
    const { entries } = await findConcalls(page, ticker);

    // Keep only rows with a real "Mon YYYY" date — drops the "Add Missing"
    // button row and any header noise. Screener lists concalls newest-first.
    const datedAll = entries.filter((e) => e.date);
    if (!datedAll.length) {
      await saveShot(page, `no-concalls-${ticker}.png`);
      return { ticker, error: "No dated concall rows found on the company page." };
    }

    // Collapse rows that resolve to the SAME month. Screener's broad row scan can
    // capture nested wrappers of a single concall as separate "rows" (and a month
    // can also appear in unrelated blocks), which would otherwise classify the
    // SAME quarter twice under one date — wasting an LLM call and, because the
    // tear-sheet store is keyed by concall_date, silently dropping a real prior
    // quarter from the timeline. Newest-first order is preserved; the first
    // (richest, top-most) occurrence of each month wins.
    const dated = [];
    const seenMonth = new Set();
    for (const e of datedAll) {
      const iso = toIsoDate(e.date);
      if (!iso || seenMonth.has(iso)) continue;
      seenMonth.add(iso);
      dated.push(e);
    }

    const latest = dated[0];

    let summary = await extractAiSummary(page, context, latest, url);
    if (!summary) summary = await extractTranscript(context, latest);
    if (!summary) {
      await saveShot(page, `no-summary-${ticker}.png`);
      return { ticker, error: "Found concalls but could not extract an AI summary or transcript." };
    }

    // Diagnostic: how much did we extract, and what does the AI summary look like?
    log(
      `extracted ${summary.source}: ${summary.raw_text.length} chars, ${summary.key_takeaways.length} takeaways, ${summary.pressing_questions.length} questions`
    );
    if (summary.source === "ai_summary") {
      log("AI SUMMARY TEXT (first 1500 chars):\n" + summary.raw_text.slice(0, 1500));
    }

    // Best-effort history (older quarters). PREFER each quarter's AI summary
    // (cleaner, avoids transcript-PDF parse failures); fall back to the PDF.
    const history = [];
    for (let i = 1; i < Math.min(dated.length, maxHistory); i++) {
      try {
        let h = await fetchHostedSummary(context, dated[i]);
        if (h) log(`history[${i}] ${dated[i].date}: via ai_summary`);
        if (!h) h = await extractTranscript(context, dated[i]);
        if (h) {
          const hMonth = toIsoDate(dated[i].date);
          const hPrecise = preciseConcallDate(h.raw_text, hMonth) || preciseConcallDate(dated[i].rowText, hMonth);
          history.push({ concall_date: hPrecise || hMonth, ...h, company, ticker });
        }
      } catch (e) {
        warn("history quarter failed", e.message);
      }
    }

    // Refine the month-level listing date to the ACTUAL call day when the text
    // states it (guarded to the listing month); otherwise keep the month default.
    const latestMonth = toIsoDate(latest.date);
    const latestPrecise =
      preciseConcallDate(summary.raw_text, latestMonth) ||
      preciseConcallDate(latest.rowText, latestMonth);
    if (latestPrecise && latestPrecise !== latestMonth) log(`precise concall date: ${latestPrecise} (listing ${latestMonth})`);

    return {
      ticker,
      company,
      industry: industry || null,
      concall_date: latestPrecise || latestMonth,
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
