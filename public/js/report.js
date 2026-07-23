/**
 * report.js — marketing-grade, print-optimised PDF export.
 * ==============================================================================
 * This does NOT screenshot the live dashboard. It builds a dedicated A4 report
 * DOM with its own print stylesheet, flows the content into fixed pages with
 * controlled breaks (a block never straddles a page; tables/lists are
 * pre-chunked so no row is ever cut), stamps a header + page-numbered footer on
 * every page, then rasterises each page (html2canvas @2x) into a jsPDF A4 doc.
 *
 * Branding: public/assets/munshot-logo.png when present, else a "MUNSHOT"
 * wordmark. "Prepared by Munshot for Daksham Capital" throughout.
 */
import { escapeHtml, fmtDate } from "./ui.js";

/* A4 @ ~96dpi, and the usable content box inside the margins. */
const PAGE_W = 794;
const PAGE_H = 1123;
const PAD_X = 54;
const HEAD_TOP = 82; // where content starts (below the running header)
const FOOT_ZONE = 74; // reserved at the bottom for the footer
const CONTENT_W = PAGE_W - PAD_X * 2;
const CONTENT_H = PAGE_H - HEAD_TOP - FOOT_ZONE;
const BLOCK_GAP = 15;

const SECTION_TITLE = {
  FIN: "Financial Performance", ORD: "Order Book & Demand",
  SEG: "Segment & Product Performance", TECH: "Product & Technology",
  MFG: "Manufacturing & Capacity", GEO: "Geography & Distribution",
  SUP: "Supply Chain & Operations", MKT: "Market & Customer Strategy",
  STRAT: "Strategic Initiatives & M&A", RISK: "Risks & External Factors",
  GUID: "Guidance & Outlook",
};
const ORDER = ["FIN", "ORD", "SEG", "TECH", "MFG", "GEO", "SUP", "MKT", "STRAT", "RISK", "GUID"];

const KIND_LABEL = { reported: "Reported", guidance: "Guidance", target: "Target", market_size: "Market size" };
const clean = (v) => {
  const s = (v ?? "").toString().trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : "";
};
/** A unit span, unless the value already ends with that unit (e.g. "25%"+"%"). */
const unitSpan = (value, unit, cls = "u") => {
  const u = clean(unit);
  if (!u) return "";
  const v = String(value ?? "").trim().toLowerCase();
  const uu = u.toLowerCase();
  // Skip a unit the value already carries — as a suffix ("25%" + "%") or a
  // prefix ("INR50,000 crores" + "INR", common for currency tokens).
  if (v && (v.endsWith(uu) || v.startsWith(uu))) return "";
  return ` <span class="${cls}">${escapeHtml(u)}</span>`;
};
/** Trim to a bounded length at a word boundary. The cover is a fixed-height
 *  page with overflow:hidden, so long model output (summary, theme labels) must
 *  be capped or it overlaps the absolutely-positioned note/footer. */
const clip = (v, n) => {
  const s = clean(v);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, "") + "…";
};

/* ------------------------------------------------------------------ entry -- */
export async function exportReportPdf(model, { onStage } = {}) {
  if (typeof window.jspdf === "undefined" || typeof window.html2canvas === "undefined") {
    throw new Error("PDF libraries unavailable");
  }
  onStage?.("Preparing report…");
  injectStyles();
  const logo = await loadLogo();
  const root = document.createElement("div");
  root.className = "dk-report";
  root.style.cssText = "position:fixed;left:-12000px;top:0;z-index:-1;";
  document.body.appendChild(root);

  try {
    const pageEls = composePages(model, logo, root);
    const N = pageEls.length;
    root.style.width = PAGE_W + "px"; // stacked pages, no gaps

    // Crisp fixed scale, rendered in page-batches that each stay under the
    // browser's ~16k px canvas-height cap. Non-batch pages are hidden so each
    // pass only rasterises its own pages (fast) — and any report length is safe.
    const S = 2;
    const perBatch = Math.max(1, Math.floor(15800 / (PAGE_H * S)));
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pw = Math.round(PAGE_W * S);
    const ph = Math.round(PAGE_H * S);
    const slice = document.createElement("canvas");
    slice.width = pw;
    slice.height = ph;
    const cx = slice.getContext("2d");

    let done = 0;
    for (let start = 0; start < N; start += perBatch) {
      const count = Math.min(perBatch, N - start);
      onStage?.(`Rendering page ${start + 1}${count > 1 ? "–" + (start + count) : ""} of ${N}…`);
      pageEls.forEach((p, idx) => {
        p.style.display = idx >= start && idx < start + count ? "" : "none";
      });
      const batch = await window.html2canvas(root, {
        scale: S, backgroundColor: "#ffffff", useCORS: true, logging: false,
        width: PAGE_W, height: count * PAGE_H, windowWidth: PAGE_W, windowHeight: count * PAGE_H,
      });
      for (let k = 0; k < count; k++) {
        cx.clearRect(0, 0, pw, ph);
        cx.drawImage(batch, 0, k * ph, pw, ph, 0, 0, pw, ph);
        if (done > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/png"), "PNG", 0, 0, 210, 297, undefined, "FAST");
        // Clickable www.muns.io — derive the rect from the rendered footer link
        // itself. The footer is justify-content:space-between, so the link's x
        // shifts with the side text; a fixed rectangle would miss it.
        const pageEl = pageEls[start + k];
        const linkEl = pageEl.querySelector(".rpt-foot-link");
        if (linkEl) {
          const pr = pageEl.getBoundingClientRect();
          const lr = linkEl.getBoundingClientRect();
          const mmX = 210 / PAGE_W, mmY = 297 / PAGE_H;
          const padY = 1.3; // small vertical cushion → friendlier click target
          pdf.link((lr.left - pr.left) * mmX, (lr.top - pr.top) * mmY - padY, lr.width * mmX, lr.height * mmY + 2 * padY, { url: "https://www.muns.io" });
        }
        done++;
      }
    }
    pageEls.forEach((p) => (p.style.display = ""));
    pdf.save(fileName(model, "pdf"));
  } finally {
    document.body.removeChild(root);
  }
}

/** Build cover + paginated body pages into `root` and return the page elements.
 *  Pagination separated from rasterisation so it can be previewed/tested. */
function composePages(model, logo, root) {
  const meas = document.createElement("div");
  meas.style.cssText = `position:absolute;left:0;top:0;width:${CONTENT_W}px;visibility:hidden;`;
  root.appendChild(meas);
  const measure = (el) => {
    meas.appendChild(el);
    const h = el.offsetHeight;
    meas.removeChild(el);
    return h;
  };

  // Measure each block; any block taller than a page is split by MEASURED height
  // (lists by item, text by word) so nothing is ever clipped by overflow:hidden.
  const blocks = [];
  for (const b of bodyBlocks(model)) {
    const h = measure(b.el);
    if (h <= CONTENT_H) {
      blocks.push({ el: b.el, h, keep: b.el.classList?.contains("rpt-keep") });
      continue;
    }
    for (const part of splitToFit(b.el, measure)) {
      blocks.push({ el: part, h: measure(part), keep: part.classList?.contains("rpt-keep") });
    }
  }
  root.removeChild(meas);

  // Greedy-pack blocks into pages. A ".rpt-keep" heading uses keep-with-next: it
  // won't be left orphaned at the bottom of a page — if its following block
  // wouldn't also fit, break first.
  const pagesBlocks = [];
  let cur = [];
  let runH = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    let need = b.h;
    if (b.keep && blocks[i + 1]) need += blocks[i + 1].h + BLOCK_GAP;
    if (cur.length && runH + need > CONTENT_H) {
      pagesBlocks.push(cur);
      cur = [];
      runH = 0;
    }
    cur.push(b.el);
    runH += b.h + BLOCK_GAP;
  }
  if (cur.length) pagesBlocks.push(cur);

  const totalPages = pagesBlocks.length + 2; // cover + body pages + thank-you
  const pageEls = [coverPage(model, logo, totalPages)];
  pagesBlocks.forEach((bl, i) => pageEls.push(bodyPage(model, logo, bl, i + 2, totalPages)));
  pageEls.push(thankYouPage(model, logo, totalPages));
  pageEls.forEach((p) => root.appendChild(p));
  return pageEls;
}

/** Render the report pages into a VISIBLE container (preview / verification). */
export async function renderReportInto(model, mountEl) {
  injectStyles();
  const logo = await loadLogo();
  mountEl.classList.add("dk-report");
  return composePages(model, logo, mountEl);
}

export function fileName(model, ext) {
  const co = (model.company || model.ticker || "Company").replace(/[^A-Za-z0-9]+/g, "");
  const d = (model.concall_date || "").slice(0, 10) || "latest";
  return `Daksham_${co}_Concall_${d}.${ext}`;
}

/* ---------------------------------------------------------------- model ---- */
/** Normalise a tear-sheet quarter into a rendering model. */
export function buildReportModel(ticker, comp, q) {
  const sections = (q.sections || [])
    .filter((s) => s && (s.key_figures?.length || s.subsections?.some((x) => x.points?.length)))
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return {
    ticker,
    company: comp?.company || ticker,
    industry: comp?.industry || null,
    country: comp?.country || null,
    concall_date: q.concall_date || null,
    source: q.source || null,
    summary: q.summary || "",
    sections,
    guidance_ledger: (q.guidance_ledger || []).filter(Boolean),
    risk_register: (q.risk_register || []).filter(Boolean),
    themes: (q.themes || []).filter(Boolean),
    key_takeaways: (q.key_takeaways || []).filter(Boolean),
    pressing_questions: (q.pressing_questions || []).filter(Boolean),
  };
}

/* ------------------------------------------------------------- builders ---- */
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
/** Chunk an array so each rendered block stays within one page. */
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* ---- Oversized-block splitting: a safety net so a block taller than a page is
   never silently clipped by .rpt-page's overflow:hidden (lists split by item,
   text by word — all by MEASURED height). ------------------------------------ */
function splitToFit(el, measure) {
  const ul = el.querySelector("ul");
  if (ul && ul.children.length) return splitList(el, measure);
  return splitText(el, measure);
}
function shellWithEmptyList(el) {
  const clone = el.cloneNode(true);
  const ul = clone.querySelector("ul");
  if (ul) ul.innerHTML = "";
  return clone;
}
function splitList(el, measure) {
  const items = [...el.querySelector("ul").children].map((li) => li.outerHTML);
  const parts = [];
  let i = 0, guard = 0;
  while (i < items.length && guard++ < 4000) {
    const clone = shellWithEmptyList(el);
    const ul = clone.querySelector("ul");
    let added = 0;
    while (i < items.length) {
      ul.insertAdjacentHTML("beforeend", items[i]);
      if (added > 0 && measure(clone) > CONTENT_H) {
        ul.removeChild(ul.lastElementChild);
        break;
      }
      added++;
      i++;
    }
    if (added === 0) {
      splitLongItem(el, items[i], measure).forEach((p) => parts.push(p));
      i++;
      continue;
    }
    parts.push(clone);
  }
  return parts;
}
function splitLongItem(el, liHtml, measure) {
  const tmp = document.createElement("div");
  tmp.innerHTML = liHtml;
  const words = (tmp.textContent || "").split(/\s+/).filter(Boolean);
  return fillByWords(
    () => {
      const c = shellWithEmptyList(el);
      c.querySelector("ul").appendChild(document.createElement("li"));
      return c;
    },
    (c, t) => (c.querySelector("li").textContent = t),
    words,
    measure
  );
}
function splitText(el, measure) {
  const sel = "p, .rpt-card-body, .rpt-risk-note";
  const target = el.querySelector(sel) || el;
  const words = (target.textContent || "").split(/\s+/).filter(Boolean);
  if (words.length < 2) return [el];
  return fillByWords(
    () => el.cloneNode(true),
    (c, t) => ((c.querySelector(sel) || c).textContent = t),
    words,
    measure
  );
}
function fillByWords(makeEmpty, setText, words, measure) {
  const parts = [];
  let i = 0, guard = 0;
  while (i < words.length && guard++ < 8000) {
    const clone = makeEmpty();
    let text = "", added = 0;
    while (i < words.length) {
      const next = text ? text + " " + words[i] : words[i];
      setText(clone, next);
      if (added > 0 && measure(clone) > CONTENT_H) {
        setText(clone, text);
        break;
      }
      text = next;
      added++;
      i++;
    }
    if (added === 0) {
      setText(clone, words[i]);
      i++;
    }
    parts.push(clone);
  }
  return parts;
}

function bodyBlocks(m) {
  const blocks = [];
  const push = (node) => blocks.push({ el: node });

  if (m.summary)
    push(el(`<div class="rpt-block rpt-summary"><div class="rpt-eyebrow">Outlook summary</div><p>${escapeHtml(m.summary)}</p></div>`));

  if (m.themes.length)
    push(el(`<div class="rpt-block"><div class="rpt-h">Running Themes</div><div class="rpt-themes">${m.themes
      .map((t) => `<span class="rpt-theme d-${escapeHtml(t.direction || "neutral")}">${escapeHtml(t.label)}${
        t.note ? ` — <em>${escapeHtml(t.note)}</em>` : ""
      }</span>`)
      .join("")}</div></div>`));

  // Guidance — drop carried-forward "no mention" rows; a first-time item shows
  // no chip (only real deltas Raised/Lowered/… carry one), matching the board.
  const guid = m.guidance_ledger.filter((g) => g.status !== "no_mention");
  if (guid.length) {
    push(el(`<div class="rpt-block rpt-keep"><div class="rpt-h">Guidance &amp; Outlook</div></div>`));
    for (const g of guid) {
      const showChip = g.status && g.status !== "new";
      push(el(`<div class="rpt-block rpt-card">
        <div class="rpt-card-top"><span class="rpt-metric">${escapeHtml(g.metric || "")}</span>${showChip ? `<span class="rpt-status s-${escapeHtml(g.status)}">${escapeHtml(statusLabel(g.status))}</span>` : ""}</div>
        <div class="rpt-card-body">${escapeHtml(g.statement || "")}</div>
        <div class="rpt-card-meta">${[g.direction && dirLabel(g.direction), g.horizon].filter(Boolean).map((x) => `<span>${escapeHtml(x)}</span>`).join("")}</div>
      </div>`));
    }
  }

  // Risks flagged this quarter; carried-forward "no mention" hidden, "new" chip
  // suppressed. A dot anchors each row so first-time risks don't read as bare.
  const risks = m.risk_register.filter((r) => r.status !== "no_mention");
  if (risks.length) {
    push(el(`<div class="rpt-block rpt-keep"><div class="rpt-h">Risk Register</div></div>`));
    for (const r of risks) {
      const showChip = r.status && r.status !== "new";
      push(el(`<div class="rpt-block rpt-risk">
        <span class="rpt-risk-dot"></span>
        <div><div class="rpt-risk-name">${escapeHtml(r.risk || "")}${showChip ? ` <span class="rpt-status s-${escapeHtml(r.status)}">${escapeHtml(statusLabel(r.status))}</span>` : ""}</div>${r.note ? `<div class="rpt-risk-note">${escapeHtml(r.note)}</div>` : ""}</div>
      </div>`));
    }
  }

  // The 11 sections.
  m.sections.forEach((s, idx) => {
    const title = s.title || SECTION_TITLE[s.id] || s.id;
    const figs = (s.key_figures || []).filter(Boolean);
    const subs = (s.subsections || []).filter((x) => x.points?.length);
    // section heading (kept with its first content on the same page via ordering)
    push(el(`<div class="rpt-block rpt-keep"><div class="rpt-sec-h"><span class="rpt-sec-n">${idx + 1}</span>${escapeHtml(title)}</div></div>`));
    // key-figures table, pre-chunked so no single table exceeds a page
    chunk(figs, 16).forEach((group, gi) =>
      push(el(`<div class="rpt-block">${kfTable(group, gi > 0)}</div>`))
    );
    // subsections (each bullet list chunked)
    subs.forEach((ss) => {
      const pts = (ss.points || []).filter(Boolean);
      chunk(pts, 14).forEach((group, gi) =>
        push(el(`<div class="rpt-block rpt-sub">${ss.label && gi === 0 ? `<div class="rpt-sub-label">${escapeHtml(ss.label)}</div>` : ""}<ul>${group.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`))
      );
    });
  });

  // Analyst read.
  if (m.key_takeaways.length) {
    push(el(`<div class="rpt-block rpt-keep"><div class="rpt-h">Key Takeaways <span class="rpt-verbatim">verbatim</span></div></div>`));
    chunk(m.key_takeaways, 14).forEach((group) =>
      push(el(`<div class="rpt-block rpt-list"><ul>${group.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div>`))
    );
  }
  return blocks;
}

function kfTable(figs, cont) {
  return `<table class="rpt-kf">
    <thead><tr><th>Metric</th><th>Value</th><th>Period</th><th>Type</th></tr></thead>
    <tbody>${figs
      .map((f) => `<tr>
        <td class="l">${escapeHtml(f.label || "")}</td>
        <td class="v">${escapeHtml(f.value ?? "")}${unitSpan(f.value, f.unit)}</td>
        <td class="p">${clean(f.period) ? escapeHtml(clean(f.period)) : "—"}</td>
        <td><span class="k k-${escapeHtml(f.kind || "reported")}">${escapeHtml(KIND_LABEL[f.kind] || "Reported")}</span></td>
      </tr>`)
      .join("")}</tbody>
  </table>${cont ? `<div class="rpt-cont">continued</div>` : ""}`;
}

/* --------------------------------------------------------------- pages ----- */
function frame(pageNo, total, m, logo) {
  const header = `<div class="rpt-header">
      <div class="rpt-hd-co">${escapeHtml(m.company)}${m.industry ? ` · <span>${escapeHtml(m.industry)}</span>` : ""}</div>
      <div class="rpt-hd-wm">${logoMark(logo, 20)}<span class="rpt-wm-text">Munshot</span></div>
    </div>`;
  const footer = `<div class="rpt-footer">
      <span>Prepared by Munshot · Daksham Capital${m.concall_date ? ` · ${escapeHtml(fmtDate(m.concall_date))}` : ""}</span>
      <span class="rpt-foot-link">www.muns.io</span>
      <span>Page ${pageNo} of ${total}</span>
    </div>`;
  return { header, footer };
}
/** Top key figures for the cover "at a glance" (Financials first). */
function topFigures(m, n) {
  // Prefer Financials, but only if it actually carries figures — otherwise fall
  // back to the first section that does (FIN may hold narrative-only subsections).
  const hasFigs = (s) => (s.key_figures || []).filter(Boolean).length;
  const fin = m.sections.find((s) => s.id === "FIN" && hasFigs(s)) || m.sections.find(hasFigs);
  return (fin?.key_figures || []).filter(Boolean).slice(0, n);
}

function bodyPage(m, logo, blockEls, pageNo, total) {
  const { header, footer } = frame(pageNo, total, m, logo);
  const page = el(`<div class="rpt-page">${header}<div class="rpt-content"></div>${footer}</div>`);
  const c = page.querySelector(".rpt-content");
  blockEls.forEach((b) => c.appendChild(b));
  return page;
}

function coverPage(m, logo, total) {
  const { footer } = frame(1, total, m, logo);
  const pills = [
    m.ticker && `<span>${escapeHtml(m.ticker)}</span>`,
    m.industry && `<span>${escapeHtml(m.industry)}</span>`,
    m.country && `<span>${escapeHtml(m.country)}</span>`,
    m.source === "ai_summary" ? `<span>AI concall summary</span>` : m.source === "transcript" ? `<span>Transcript</span>` : null,
  ].filter(Boolean).join("");

  const figs = topFigures(m, 4);
  const figsHtml = figs.length
    ? `<div class="rpt-cover-figs">${figs
        .map((f) => `<div class="rpt-cf"><div class="rpt-cf-v">${escapeHtml(f.value ?? "")}${unitSpan(f.value, f.unit, "")}</div><div class="rpt-cf-l">${escapeHtml(f.label || "")}</div></div>`)
        .join("")}</div>`
    : "";
  const themesHtml = m.themes.length
    ? `<div class="rpt-cover-themes">${m.themes
        .slice(0, 5)
        .map((t) => `<span class="rpt-ct d-${escapeHtml(t.direction || "neutral")}">${escapeHtml(clip(t.label, 34))}</span>`)
        .join("")}</div>`
    : "";

  return el(`<div class="rpt-page rpt-cover">
    <div class="rpt-cover-hero">
      <div class="rpt-cover-brandrow">
        ${logoMark(logo, 46, "rpt-cover-logo")}
        <div class="rpt-cover-brandtx"><div class="rpt-cover-word">MUNSHOT</div><div class="rpt-cover-prep">Prepared for Daksham Capital</div></div>
      </div>
    </div>
    <div class="rpt-cover-mid">
      <div class="rpt-cover-eyebrow">Earnings Concall · Tear Sheet</div>
      <h1 class="rpt-cover-co">${escapeHtml(m.company)}</h1>
      <div class="rpt-cover-date">${m.concall_date ? escapeHtml(fmtDate(m.concall_date)) : "Latest concall"}</div>
      <div class="rpt-cover-pills">${pills}</div>
      <div class="rpt-cover-glance">
        <div class="rpt-cover-glance-h">At a glance</div>
        ${m.summary ? `<p>${escapeHtml(clip(m.summary, 340))}</p>` : ""}
        ${figsHtml}
        ${themesHtml}
      </div>
    </div>
    <div class="rpt-cover-note">The AI organises — it does not opine. Every figure is reproduced verbatim from the
      source concall and reorganised into Daksham's fixed 11-section framework — each figure traceable to the call it was
      drawn from. Open the live tear sheet to cross-verify any figure at its source.</div>
    ${footer}
  </div>`);
}

function thankYouPage(m, logo, total) {
  const { footer } = frame(total, total, m, logo);
  return el(`<div class="rpt-page rpt-thanks">
    <div class="rpt-thanks-mid">
      ${logoMark(logo, 66, "rpt-thanks-logo")}
      <div class="rpt-thanks-word">MUNSHOT</div>
      <h2 class="rpt-thanks-h">Thank you.</h2>
      <p class="rpt-thanks-p">This tear sheet was prepared by <b>Munshot</b> for <b>Daksham Capital</b>.<br/>
        Concall intelligence, organised — never opined.</p>
      <div class="rpt-thanks-link">www.muns.io</div>
    </div>
    ${footer}
  </div>`);
}

/* --------------------------------------------------------------- helpers --- */
function statusLabel(s) {
  const m = { new: "New", reiterated: "Reiterated", raised: "Raised", lowered: "Lowered", achieved: "Achieved", missed: "Missed", pushed_out: "Pushed out", dropped: "Dropped", no_mention: "No mention", escalated: "Escalated", stable: "Stable", easing: "Easing", resolved: "Resolved" };
  return m[s] || "New";
}
function dirLabel(d) {
  return { up: "Up", down: "Down", flat: "Flat", unclear: "Unclear" }[d] || d;
}

/* The Munshot monogram, inlined so it rasterises reliably in html2canvas
   (an <img src=*.svg> often doesn't). A real PNG at the path below wins. */
const MONOGRAM = `<svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="rmgGold" x1="30" y1="26" x2="100" y2="104" gradientUnits="userSpaceOnUse">
  <stop offset="0" stop-color="#FCE58F"/><stop offset=".42" stop-color="#EBAE3A"/><stop offset="1" stop-color="#B4761A"/></linearGradient></defs>
  <path d="M38 99 V51 A17 17 0 0 1 72 51 V81" stroke="url(#rmgGold)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M56 29 V77 A17 17 0 0 0 90 77 V29" stroke="url(#rmgGold)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function loadLogo() {
  // Prefer a real PNG if the user dropped one in; else use the inline monogram.
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ png: "./assets/munshot-logo.png" });
    img.onerror = () => resolve({ png: null });
    img.src = "./assets/munshot-logo.png";
  });
}
/** Logo mark at a given pixel height — PNG if present, else the inline SVG. */
function logoMark(logo, px, cls = "") {
  return logo && logo.png
    ? `<img src="${logo.png}" class="${cls}" style="height:${px}px;width:${px}px;object-fit:cover;display:block;border-radius:${Math.max(3, Math.round(px * 0.2))}px" alt="Munshot"/>`
    : `<span class="rpt-mono ${cls}" style="width:${px}px;height:${px}px">${MONOGRAM}</span>`;
}

/* --------------------------------------------------------------- styles ---- */
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  .dk-report { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; }
  .dk-report .rpt-page { position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; background: #fff; overflow: hidden; }
  .dk-report .rpt-content { position: absolute; left: ${PAD_X}px; right: ${PAD_X}px; top: ${HEAD_TOP}px; width: ${CONTENT_W}px; }
  .dk-report .rpt-header { position: absolute; left: ${PAD_X}px; right: ${PAD_X}px; top: 30px; display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #e6e8f0; }
  .dk-report .rpt-hd-co { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 12.5px; color: #0f172a; }
  .dk-report .rpt-hd-co span { color: #64748b; font-weight: 500; }
  .dk-report .rpt-hd-wm { display: flex; align-items: center; gap: 8px; }
  .dk-report .rpt-wm-text { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: 1.5px; font-size: 12px; color: #7c3aed; }
  .dk-report .rpt-mono { display: inline-block; line-height: 0; }
  .dk-report .rpt-mono svg { width: 100%; height: 100%; display: block; }
  .dk-report .rpt-footer .rpt-foot-link { color: #b8791a; font-weight: 700; }
  .dk-report .rpt-footer { position: absolute; left: ${PAD_X}px; right: ${PAD_X}px; bottom: 28px; display: flex; justify-content: space-between; align-items: center; padding-top: 11px; border-top: 1px solid #e6e8f0; font-size: 10px; color: #94a3b8; }

  .dk-report .rpt-block { margin-bottom: ${BLOCK_GAP}px; }
  .dk-report .rpt-eyebrow, .dk-report .rpt-h { font-family: 'Space Grotesk', sans-serif; }
  .dk-report .rpt-h { font-size: 15px; font-weight: 700; color: #4f46e5; margin: 4px 0 9px; padding-bottom: 6px; border-bottom: 2px solid #ede9fe; }
  .dk-report .rpt-h .rpt-verbatim { font-size: 9px; font-weight: 700; letter-spacing: .5px; color: #10b981; background: #e7f8f1; padding: 2px 7px; border-radius: 999px; vertical-align: middle; margin-left: 6px; }
  .dk-report .rpt-summary { background: linear-gradient(135deg,#f5f3ff,#eef2ff); border: 1px solid #e0e7ff; border-radius: 12px; padding: 14px 16px; }
  .dk-report .rpt-eyebrow { font-size: 9.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #7c3aed; margin-bottom: 5px; }
  .dk-report .rpt-summary p { margin: 0; font-size: 12.5px; line-height: 1.6; color: #334155; }

  .dk-report .rpt-sec-h { display: flex; align-items: center; gap: 10px; font-family: 'Space Grotesk', sans-serif; font-size: 15px; font-weight: 700; color: #0f172a; margin: 6px 0 8px; }
  .dk-report .rpt-sec-n { flex: none; width: 22px; height: 22px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; background: linear-gradient(135deg,#7c3aed,#6366f1); }

  .dk-report .rpt-kf { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  .dk-report .rpt-kf th:nth-child(1), .dk-report .rpt-kf td.l { width: 45%; }
  .dk-report .rpt-kf th:nth-child(2), .dk-report .rpt-kf td.v { width: 24%; }
  .dk-report .rpt-kf th:nth-child(3), .dk-report .rpt-kf td.p { width: 17%; }
  .dk-report .rpt-kf td.l, .dk-report .rpt-kf td.v { overflow-wrap: anywhere; word-break: break-word; }
  .dk-report .rpt-kf th { text-align: left; font-size: 9px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #94a3b8; padding: 7px 10px; border-bottom: 1.5px solid #e6e8f0; }
  .dk-report .rpt-kf td { padding: 7px 10px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  .dk-report .rpt-kf tbody tr:nth-child(even) { background: #fafbfe; }
  .dk-report .rpt-kf td.l { color: #334155; font-weight: 500; width: 40%; }
  .dk-report .rpt-kf td.v { font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #0f172a; }
  .dk-report .rpt-kf td.v .u { color: #94a3b8; font-weight: 500; font-size: 10px; }
  .dk-report .rpt-kf td.p { color: #64748b; }
  .dk-report .rpt-kf .k { font-size: 9px; font-weight: 600; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
  .dk-report .k-reported { background: #eef2ff; color: #4f46e5; }
  .dk-report .k-guidance { background: #e7f8f1; color: #059669; }
  .dk-report .k-target { background: #fff4e5; color: #d97706; }
  .dk-report .k-market_size { background: #fce7f3; color: #db2777; }
  .dk-report .rpt-cont { font-size: 9px; color: #94a3b8; font-style: italic; padding: 4px 0 0; }

  .dk-report .rpt-sub { padding-left: 2px; }
  .dk-report .rpt-sub-label { font-size: 11px; font-weight: 700; color: #6366f1; margin-bottom: 4px; }
  .dk-report .rpt-sub ul, .dk-report .rpt-list ul { margin: 0; padding-left: 18px; }
  .dk-report .rpt-sub li, .dk-report .rpt-list li { font-size: 11.5px; line-height: 1.5; color: #334155; margin-bottom: 4px; }
  .dk-report .rpt-list.q li::marker { color: #f59e0b; }

  .dk-report .rpt-themes { display: flex; flex-direction: column; gap: 6px; }
  .dk-report .rpt-theme { font-size: 11.5px; color: #334155; padding: 6px 11px; border-radius: 8px; border-left: 3px solid #94a3b8; background: #f8fafc; }
  .dk-report .rpt-theme em { color: #64748b; font-style: normal; }
  .dk-report .rpt-theme.d-positive { border-left-color: #10b981; }
  .dk-report .rpt-theme.d-negative { border-left-color: #f43f5e; }
  .dk-report .rpt-theme.d-mixed { border-left-color: #f59e0b; }

  .dk-report .rpt-card { border: 1px solid #e6e8f0; border-radius: 10px; padding: 11px 13px; }
  .dk-report .rpt-card-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
  .dk-report .rpt-metric { font-weight: 700; font-size: 12.5px; color: #0f172a; }
  .dk-report .rpt-card-body { font-size: 11.5px; line-height: 1.5; color: #334155; }
  .dk-report .rpt-card-meta { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .dk-report .rpt-card-meta span { font-size: 9px; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 999px; }
  .dk-report .rpt-status { font-size: 9.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .dk-report .s-raised, .dk-report .s-achieved, .dk-report .s-easing, .dk-report .s-resolved { background: #e7f8f1; color: #059669; }
  .dk-report .s-lowered, .dk-report .s-missed, .dk-report .s-new, .dk-report .s-escalated { background: #ffe9ec; color: #e11d48; }
  .dk-report .s-reiterated, .dk-report .s-stable, .dk-report .s-pushed_out, .dk-report .s-dropped { background: #fff4e5; color: #d97706; }
  .dk-report .s-no_mention { background: #f1f5f9; color: #94a3b8; }

  .dk-report .rpt-risk { display: flex; gap: 11px; align-items: flex-start; border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 13px; }
  .dk-report .rpt-risk-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: #f97316; margin-top: 5px; }
  .dk-report .rpt-risk-name { font-weight: 600; font-size: 12px; color: #0f172a; }
  .dk-report .rpt-risk-name .rpt-status { margin-left: 6px; vertical-align: middle; }
  .dk-report .rpt-risk-note { font-size: 11px; color: #64748b; margin-top: 2px; line-height: 1.45; }

  /* Cover */
  .dk-report .rpt-cover { display: block; }
  .dk-report .rpt-cover-hero { position: relative; height: 158px; background: linear-gradient(120deg,#7c3aed 0%,#6366f1 42%,#3b82f6 74%,#06b6d4 100%); padding: 34px ${PAD_X}px; color: #fff; overflow: hidden; display: flex; align-items: center; }
  .dk-report .rpt-cover-hero::after { content: ""; position: absolute; right: -70px; top: -90px; width: 320px; height: 320px; border-radius: 50%; background: rgba(255,255,255,.12); }
  .dk-report .rpt-cover-brandrow { position: relative; z-index: 1; display: flex; align-items: center; gap: 18px; }
  .dk-report .rpt-cover-logo { filter: drop-shadow(0 6px 16px rgba(0,0,0,.28)); }
  .dk-report .rpt-cover-brandtx { line-height: 1.15; }
  .dk-report .rpt-cover-word { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: 5px; font-size: 30px; }
  .dk-report .rpt-cover-prep { font-size: 13.5px; font-weight: 600; opacity: .95; margin-top: 4px; }
  .dk-report .rpt-cover-mid { padding: 38px ${PAD_X}px 0; }
  .dk-report .rpt-cover-eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #7c3aed; }
  .dk-report .rpt-cover-co { font-family: 'Space Grotesk', sans-serif; font-size: 42px; font-weight: 700; letter-spacing: -1px; color: #0f172a; margin: 12px 0 8px; line-height: 1.04; }
  .dk-report .rpt-cover-date { font-size: 16px; color: #475569; font-weight: 500; }
  .dk-report .rpt-cover-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .dk-report .rpt-cover-pills span { font-size: 12px; font-weight: 600; color: #4f46e5; background: #eef2ff; border: 1px solid #e0e7ff; padding: 6px 14px; border-radius: 999px; }
  .dk-report .rpt-cover-glance { margin-top: 30px; border: 1px solid #e6e8f0; border-radius: 16px; padding: 20px 22px; background: linear-gradient(180deg,#fbfaff,#f4f6ff); }
  .dk-report .rpt-cover-glance-h { font-family: 'Space Grotesk', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #7c3aed; margin-bottom: 10px; }
  .dk-report .rpt-cover-glance p { margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: #334155; }
  .dk-report .rpt-cover-figs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
  .dk-report .rpt-cf { background: #fff; border: 1px solid #eef1f6; border-radius: 11px; padding: 12px 13px; }
  .dk-report .rpt-cf-v { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 19px; color: #0f172a; line-height: 1.1; }
  .dk-report .rpt-cf-v span { font-size: 11px; font-weight: 600; color: #94a3b8; }
  .dk-report .rpt-cf-l { font-size: 10px; color: #64748b; margin-top: 4px; line-height: 1.3; }
  .dk-report .rpt-cover-themes { display: flex; flex-wrap: wrap; gap: 7px; }
  .dk-report .rpt-ct { font-size: 11px; font-weight: 600; color: #475569; background: #fff; border: 1px solid #e6e8f0; border-left: 3px solid #94a3b8; padding: 5px 11px; border-radius: 7px; }
  .dk-report .rpt-ct.d-positive { border-left-color: #10b981; } .dk-report .rpt-ct.d-negative { border-left-color: #f43f5e; } .dk-report .rpt-ct.d-mixed { border-left-color: #f59e0b; }
  .dk-report .rpt-cover-note { position: absolute; left: ${PAD_X}px; right: ${PAD_X}px; bottom: 92px; font-size: 10.5px; line-height: 1.6; color: #94a3b8; border-top: 1px solid #eef1f6; padding-top: 14px; }

  /* Thank-you closing page */
  .dk-report .rpt-thanks { display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg,#faf9ff 0%,#eef2ff 100%); }
  .dk-report .rpt-thanks-mid { text-align: center; padding: 0 60px; }
  .dk-report .rpt-thanks-logo { margin: 0 auto 18px; filter: drop-shadow(0 8px 20px rgba(180,121,26,.28)); }
  .dk-report .rpt-thanks-word { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: 6px; font-size: 24px; color: #b8791a; }
  .dk-report .rpt-thanks-h { font-family: 'Space Grotesk', sans-serif; font-size: 40px; font-weight: 700; color: #0f172a; margin: 22px 0 12px; }
  .dk-report .rpt-thanks-p { font-size: 14px; line-height: 1.7; color: #475569; margin: 0 0 22px; }
  .dk-report .rpt-thanks-link { display: inline-block; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 15px; color: #fff; background: linear-gradient(135deg,#7c3aed,#3b82f6); padding: 11px 26px; border-radius: 999px; }
  `;
  const style = document.createElement("style");
  style.id = "dk-report-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
