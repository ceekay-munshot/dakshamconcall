/**
 * export-xlsx.js — branded Excel export of a tear sheet.
 * ==============================================================================
 * ExcelJS (CDN) when available; a clean CSV fallback if the CDN is blocked.
 * Two sheets:
 *   - "Tear Sheet": branded header, summary, coloured section bands each with a
 *     Key Figures table + sub-topic bullets, then Guidance / Risks / Themes /
 *     Key Takeaways. Gridlines off; every table cell, band and header carries a
 *     soft thin border box for a clean, ruled look.
 *   - "Key Figures": one flat, analyst-friendly table (Section/Metric/Value/…)
 *     with a frozen header row + autofilter.
 */
import { fmtDate } from "./ui.js";
import { fileName } from "./report.js";

const V = "FF7C3AED"; // violet
const INK = "FF0F172A";
const MUTE = "FF64748B";
const BAND = "FFEDE9FE";
const HEADFILL = "FFF1F5F9";
const BORDER = "FFD2D8E3"; // soft slate hairline for cell boxes

// Reusable style fragments. `box()` returns a full four-side thin border; for a
// merged range ExcelJS shares one style object across every constituent cell, so
// setting the box on any cell of the merge yields a clean perimeter (Excel hides
// the interior rules automatically).
const thin = () => ({ style: "thin", color: { argb: BORDER } });
const box = () => ({ top: thin(), left: thin(), bottom: thin(), right: thin() });
const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

const KIND_LABEL = { reported: "Reported", guidance: "Guidance", target: "Target", market_size: "Market size" };
const statusLabel = (s) =>
  ({ new: "New", reiterated: "Reiterated", raised: "Raised", lowered: "Lowered", achieved: "Achieved", missed: "Missed", pushed_out: "Pushed out", dropped: "Dropped", no_mention: "No mention", escalated: "Escalated", stable: "Stable", easing: "Easing", resolved: "Resolved" }[s] || "New");
const clean = (v) => {
  const s = (v ?? "").toString().trim();
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : "";
};

export async function exportTearSheetXlsx(model) {
  if (typeof window.ExcelJS === "undefined") return exportCsv(model);

  const wb = new window.ExcelJS.Workbook();
  wb.creator = "Munshot · Daksham Capital";
  buildTearSheet(wb, model);
  buildKeyFigures(wb, model);

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName(model, "xlsx"));
}

/* ------------------------------------------------------------ sheet 1 ------ */
function buildTearSheet(wb, m) {
  const ws = wb.addWorksheet("Tear Sheet", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 12 }, { width: 14 }, { width: 16 }, { width: 30 }];
  const NCOL = 6;
  let r = 1;

  const merge = (row, text, opts = {}) => {
    ws.mergeCells(row, 1, row, NCOL);
    const c = ws.getCell(row, 1);
    c.value = text;
    c.font = opts.font || {};
    c.alignment = { vertical: "middle", wrapText: true, ...(opts.align || {}) };
    if (opts.fill) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
    if (opts.height) ws.getRow(row).height = opts.height;
    return c;
  };

  // Branded header
  merge(r++, "MUNSHOT  ·  Prepared for Daksham Capital", { font: { bold: true, color: { argb: "FFFFFFFF" }, size: 12, name: "Calibri" }, fill: V, height: 26, align: { horizontal: "left" } });
  merge(r++, m.company, { font: { bold: true, size: 18, color: { argb: INK }, name: "Calibri" }, height: 26 });
  const meta = [m.ticker, m.industry, m.country, m.concall_date ? fmtDate(m.concall_date) : null, m.source === "ai_summary" ? "AI summary" : m.source === "transcript" ? "Transcript" : null].filter(Boolean).join("   ·   ");
  merge(r++, meta, { font: { size: 10.5, color: { argb: MUTE } } });
  r++;

  if (m.summary) {
    band(ws, r++, "Outlook", NCOL);
    const c = merge(r++, m.summary, { font: { size: 10.5, color: { argb: "FF334155" } }, align: { indent: 1 } });
    c.border = box();
    ws.getRow(c.row).height = Math.min(120, 18 + Math.ceil(m.summary.length / 90) * 15);
    r++;
  }

  // 11 sections, each a coloured band + Key Figures table + bullets
  m.sections.forEach((s, i) => {
    band(ws, r++, `${i + 1}.  ${s.title || s.id}`, NCOL);
    const figs = (s.key_figures || []).filter(Boolean);
    if (figs.length) {
      tableHeader(ws, r++, ["Metric", "Value", "Unit", "Period", "Type"], NCOL);
      for (const f of figs) {
        const row = ws.getRow(r++);
        row.getCell(1).value = f.label || "";
        row.getCell(2).value = f.value ?? "";
        row.getCell(3).value = clean(f.unit);
        row.getCell(4).value = clean(f.period);
        row.getCell(5).value = KIND_LABEL[f.kind] || "Reported";
        styleDataRow(row, NCOL);
        ws.mergeCells(row.number, 5, row.number, NCOL);
        row.height = narrativeHeight([[f.label, 36]]);
      }
    }
    for (const ss of (s.subsections || []).filter((x) => x.points?.length)) {
      if (ss.label) merge(r++, ss.label, { font: { bold: true, size: 10, color: { argb: "FF6366F1" } } });
      for (const p of ss.points.filter(Boolean)) {
        const c = merge(r++, "•  " + p, { font: { size: 10, color: { argb: "FF334155" } }, align: { indent: 1 } });
        ws.getRow(c.row).height = Math.max(15, 15 * Math.ceil((p.length + 4) / 95));
      }
    }
    r++;
  });

  // Guidance ledger
  if (m.guidance_ledger.length) {
    band(ws, r++, "Guidance vs Delivery", NCOL);
    tableHeader(ws, r++, ["Metric", "Statement", "", "Direction", "Horizon", "Status"], NCOL);
    for (const g of m.guidance_ledger) {
      const row = ws.getRow(r++);
      row.getCell(1).value = g.metric || "";
      row.getCell(2).value = g.statement || "";
      ws.mergeCells(row.number, 2, row.number, 3);
      row.getCell(4).value = g.direction || "";
      row.getCell(5).value = g.horizon || "";
      row.getCell(6).value = statusLabel(g.status);
      styleDataRow(row, NCOL);
      row.height = narrativeHeight([[g.statement, 33], [g.metric, 33]]);
    }
    r++;
  }

  // Risk register
  if (m.risk_register.length) {
    band(ws, r++, "Risk Register", NCOL);
    tableHeader(ws, r++, ["Risk", "", "Status", "Note", "", ""], NCOL);
    for (const rk of m.risk_register) {
      const row = ws.getRow(r++);
      row.getCell(1).value = rk.risk || "";
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(3).value = statusLabel(rk.status);
      row.getCell(4).value = rk.note || "";
      ws.mergeCells(row.number, 4, row.number, NCOL);
      styleDataRow(row, NCOL);
      row.height = narrativeHeight([[rk.note, 63], [rk.risk, 55]]);
    }
    r++;
  }

  // Themes
  if (m.themes.length) {
    band(ws, r++, "Running Themes", NCOL);
    tableHeader(ws, r++, ["Theme", "", "Direction", "Note", "", ""], NCOL);
    for (const t of m.themes) {
      const row = ws.getRow(r++);
      row.getCell(1).value = t.label || "";
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(3).value = t.direction || "";
      row.getCell(4).value = t.note || "";
      ws.mergeCells(row.number, 4, row.number, NCOL);
      styleDataRow(row, NCOL);
      row.height = narrativeHeight([[t.note, 63], [t.label, 55]]);
    }
    r++;
  }

  // Lists
  const list = (title, items) => {
    if (!items.length) return;
    band(ws, r++, title, NCOL);
    for (const it of items) {
      const c = merge(r++, "•  " + it, { font: { size: 10, color: { argb: "FF334155" } } });
      ws.getRow(c.row).height = Math.max(15, 15 * Math.ceil((it.length + 4) / 95));
    }
    r++;
  };
  list("Key Takeaways (verbatim)", m.key_takeaways);
}

/* ------------------------------------------------------------ sheet 2 ------ */
function buildKeyFigures(wb, m) {
  const rows = [];
  m.sections.forEach((s) => {
    (s.key_figures || []).filter(Boolean).forEach((f) => {
      rows.push([s.title || s.id, f.label || "", f.value ?? "", clean(f.unit), clean(f.period), KIND_LABEL[f.kind] || "Reported"]);
    });
  });
  if (!rows.length) return;
  const ws = wb.addWorksheet("Key Figures", { views: [{ showGridLines: false, state: "frozen", ySplit: 1 }] });
  ws.columns = [{ width: 30 }, { width: 34 }, { width: 16 }, { width: 12 }, { width: 14 }, { width: 14 }];
  const head = ws.addRow(["Section", "Metric", "Value", "Unit", "Period", "Type"]);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10.5 };
    c.fill = solid(V);
    c.alignment = { vertical: "middle", indent: 1 };
    c.border = box();
  });
  ws.getRow(1).height = 22;
  rows.forEach((rvals) => {
    const row = ws.addRow(rvals);
    row.eachCell((c, col) => {
      c.font = { size: 10, color: { argb: col === 3 ? INK : "FF334155" }, bold: col === 3 };
      c.alignment = { vertical: "top", wrapText: col === 2, indent: col === 1 ? 1 : 0 };
      c.border = box();
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
}

/* --------------------------------------------------------------- style ----- */
function band(ws, r, text, ncol) {
  ws.mergeCells(r, 1, r, ncol);
  const c = ws.getCell(r, 1);
  c.value = text;
  c.font = { bold: true, size: 11.5, color: { argb: V }, name: "Calibri" };
  c.fill = solid(BAND);
  c.alignment = { vertical: "middle", indent: 1 };
  c.border = box();
  ws.getRow(r).height = 22;
}
function tableHeader(ws, r, labels, ncol) {
  const row = ws.getRow(r);
  // Paint + box every column so the header frame lines up with the data below,
  // even where the data merges trailing columns.
  for (let i = 1; i <= ncol; i++) {
    const c = row.getCell(i);
    c.value = labels[i - 1] || "";
    c.font = { bold: true, size: 9, color: { argb: MUTE } };
    c.fill = solid(HEADFILL);
    c.border = box();
    c.alignment = { vertical: "middle", indent: i === 1 ? 1 : 0 };
  }
  // Empty labels flag a continuation of the previous heading → merge to mirror
  // the data-row merges (e.g. a wide "Statement" or "Note" column).
  let p = 1;
  while (p <= ncol) {
    let q = p;
    while (q + 1 <= ncol && !(labels[q] || "")) q++;
    if (q > p) ws.mergeCells(r, p, r, q);
    p = q + 1;
  }
  row.height = 18;
}
function styleDataRow(row, ncol) {
  for (let i = 1; i <= ncol; i++) {
    const c = row.getCell(i);
    if (!c.font) c.font = {};
    c.font = { size: 10, color: { argb: i === 2 ? INK : "FF334155" }, ...(i === 1 ? { bold: true } : {}) };
    c.alignment = { vertical: "top", wrapText: true, indent: i === 1 ? 1 : 0 };
    c.border = box();
  }
}
/** Row height for wrapped merged cells (spreadsheets don't auto-fit merges).
 *  pairs = [[text, approxCharsPerLine], …]; the tallest cell wins. */
function narrativeHeight(pairs) {
  let lines = 1;
  for (const [text, cpl] of pairs) {
    lines = Math.max(lines, Math.ceil((String(text || "").length + 2) / cpl));
  }
  return Math.min(170, Math.max(16, lines * 15));
}

/* --------------------------------------------------------------- csv -------- */
function exportCsv(m) {
  const esc = (v) => {
    let s = String(v ?? "");
    // Neutralise spreadsheet formula injection — cells beginning with = + - @
    // (or tab/CR) are interpreted as formulas by Excel/Sheets even when quoted.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [];
  lines.push(["Munshot · Prepared for Daksham Capital"].map(esc).join(","));
  lines.push([m.company, m.ticker, m.industry || "", m.concall_date ? fmtDate(m.concall_date) : ""].map(esc).join(","));
  lines.push("");
  lines.push(["Section", "Metric", "Value", "Unit", "Period", "Type"].map(esc).join(","));
  m.sections.forEach((s) =>
    (s.key_figures || []).filter(Boolean).forEach((f) =>
      lines.push([s.title || s.id, f.label || "", f.value ?? "", clean(f.unit), clean(f.period), KIND_LABEL[f.kind] || "Reported"].map(esc).join(","))
    )
  );
  download(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }), fileName(m, "csv"));
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
