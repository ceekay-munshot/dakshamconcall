/**
 * classify.mjs — organize a Screener concall summary into the fixed schema.
 * =========================================================================
 * GUIDING PRINCIPLE: the AI ORGANIZES, it does NOT opine. We reformat the
 * trusted Screener summary into our 11-section schema and keep Screener's own
 * "Key Takeaways" verbatim. One pinned model, temperature 0, fixed strict
 * schema -> same input yields the same structure every quarter.
 *
 * Guidance-vs-delivery statuses are finalized DETERMINISTICALLY in code
 * (diffGuidance), using the prior quarter's ledger — not left to the model.
 */

import { openaiStructured, MODEL } from "./llm.mjs";

/** The FIXED 11 sections + one-line scopes (kept identical every quarter). */
export const SECTIONS = [
  { id: "FIN", title: "Financial Performance", scope: "P&L, margins, balance sheet, cash flow, capital allocation" },
  { id: "ORD", title: "Order Book & Demand", scope: "intake, backlog, pipeline, demand drivers, pricing" },
  { id: "SEG", title: "Segment & Product Performance", scope: "division/segment/brand revenue, mix, margins" },
  { id: "TECH", title: "Product & Technology", scope: "new products, R&D, IP, certifications, tech strategy" },
  { id: "MFG", title: "Manufacturing & Capacity", scope: "capacity, utilization, facilities, expansion, integration" },
  { id: "GEO", title: "Geography & Distribution", scope: "domestic/export split, regions, channels, new markets" },
  { id: "SUP", title: "Supply Chain & Operations", scope: "inventory, sourcing, logistics, ERP, systems" },
  { id: "MKT", title: "Market & Customer Strategy", scope: "customer wins, GTM, competition, TAM, market share" },
  { id: "STRAT", title: "Strategic Initiatives & M&A", scope: "acquisitions, demergers, partnerships, restructuring" },
  { id: "RISK", title: "Risks & External Factors", scope: "every management-flagged headwind (mandatory section)" },
  { id: "GUID", title: "Guidance & Outlook", scope: "all forward-looking company targets (feeds the guidance ledger)" },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Strict JSON schema for OpenAI Structured Outputs (all keys required). */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "sections", "guidance_ledger", "risk_register", "key_takeaways", "pressing_questions", "themes"],
  properties: {
    summary: { type: "string", description: "One or two sentences capturing the forward outlook, organized from the source (no new opinion)." },
    sections: {
      type: "array",
      description: "Include ONLY sections that have content, but move EVERY disclosure into its best-fit section and PRESERVE all detail. Reuse the source's labels where possible.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "key_figures", "subsections"],
        properties: {
          id: { type: "string", enum: SECTION_IDS },
          title: { type: "string" },
          key_figures: {
            type: "array",
            description:
              "EVERY quantitative disclosure in this section. If the summary states a number, it MUST appear here — never summarize numbers away.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value", "unit", "period", "kind"],
              properties: {
                label: { type: "string" },
                value: { type: "string", description: "Exact figure as stated (keep the number)." },
                unit: { type: ["string", "null"] },
                period: { type: ["string", "null"] },
                kind: { type: "string", enum: ["reported", "guidance", "target", "market_size"] },
              },
            },
          },
          subsections: {
            type: "array",
            description:
              "The section's thematic detail as full points; reuse the source's own headings as labels. Do not boil multi-point detail down to a single line.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "points"],
              properties: {
                label: { type: "string" },
                points: { type: "array", items: { type: "string" }, description: "Full detail points — keep every specific." },
              },
            },
          },
        },
      },
    },
    guidance_ledger: {
      type: "array",
      description: "EVERY forward-looking company target in the call — include all of them, do not cap or drop any. Status is finalized in code — set your best guess.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "horizon", "statement", "specificity", "direction", "status"],
        properties: {
          metric: { type: "string" },
          horizon: { type: ["string", "null"], description: "e.g. FY25, H2, next 2 years" },
          statement: { type: "string", description: "The guidance verbatim / lightly normalized." },
          specificity: { type: "string", enum: ["specific", "vague", "refused"] },
          direction: { type: "string", enum: ["up", "down", "flat", "unclear"] },
          status: { type: "string", enum: ["new", "reiterated", "raised", "lowered", "achieved", "missed", "pushed_out", "dropped", "no_mention"] },
        },
      },
    },
    risk_register: {
      type: "array",
      description: "Every management-flagged headwind.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "status", "note"],
        properties: {
          risk: { type: "string" },
          status: { type: "string", enum: ["new", "escalated", "stable", "easing", "resolved", "no_mention"] },
          note: { type: ["string", "null"] },
        },
      },
    },
    key_takeaways: { type: "array", items: { type: "string" }, description: "Screener's Key Takeaways, VERBATIM." },
    pressing_questions: { type: "array", items: { type: "string" } },
    themes: {
      type: "array",
      description:
        "3-7 short, reusable themes running through this call (the topics a sector is tracked on). Reuse a prior quarter's label when the same topic recurs — labels are cross-quarter join keys.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "direction", "note", "section_ref"],
        properties: {
          label: {
            type: "string",
            description:
              'Short reusable topic, e.g. "Input-cost inflation", "Export tailwind", "Capacity expansion", "Demand recovery", "Pricing power".',
          },
          direction: { type: "string", enum: ["positive", "negative", "neutral", "mixed"] },
          note: { type: "string", description: "One line, faithful to the source (no new opinion)." },
          section_ref: { type: "string", enum: SECTION_IDS },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  "You are a data organizer for an equity-research tracker.",
  "You REORGANIZE the provided earnings-call summary into a fixed schema and PRESERVE its detail — you do NOT summarize the summary.",
  "Move EVERY disclosure in the source into its single best-fit section. Do not drop specifics, and do not paraphrase away detail.",
  "You do NOT add opinions or analysis of your own.",
  "key_figures must carry EVERY quantitative disclosure in that section — every number the summary states, with its exact value, unit, period and kind. If the summary states a number, it MUST appear.",
  "Capture EVERY quantitative disclosure of ANY kind as its own key_figure — financial, operational, or anything else the source puts a number on. The example lists below are ILLUSTRATIVE, never a closed checklist: if the source states a number that none of the examples mention, it STILL must appear. Never let an example list act as a filter that drops an unlisted metric — when unsure whether a number matters, KEEP it.",
  "Financial rows to keep as their own key_figures when stated (examples only): revenue (quarter and full-year), revenue growth (YoY and QoQ), EBITDA, EBITDA margin, EBITDA growth, PAT, PAT growth — never fold a growth or margin figure into another row.",
  "Operational metrics matter just as much and must never be skipped (examples only): subscriber / customer / user / member / account counts, ARPU, net adds, churn, volumes, realizations, usage, utilization, occupancy, order book / backlog / pipeline, store / outlet counts, capacity, patents — and ANY other per-segment or per-brand operating metric, whether or not it is listed here.",
  "CONSOLIDATED vs STANDALONE: when the source reports the SAME metric on both a consolidated and a standalone basis, keep the CONSOLIDATED value only and drop the standalone duplicate. Use a standalone value ONLY for a metric where no consolidated figure is given.",
  "Classify every disclosure by its MEANING, not by a keyword in its heading: a telecom or digital-services BUSINESS update belongs in Segment & Product Performance (not Product & Technology); a green-energy or plant CAPACITY note belongs in Manufacturing & Capacity; a financing/telecom-business number is a Segment figure, not a Product & Technology one.",
  "subsections must carry the real thematic detail as full points (reuse the source's own headings as labels where possible), not one-line boil-downs.",
  "A subsections point should EXPLAIN a figure (the driver, cause or 'why'), not merely restate a number that already appears in key_figures. Never assert a causal claim the source does not support (e.g. do not attribute one movement to two contradictory causes).",
  "Reproduce the source's Key Takeaways, and any highlighted/unanswered questions, VERBATIM — do not reword, shorten or drop them. If the summary text contains a Key Takeaways / Highlights block, copy those bullets exactly.",
  "Also surface 3-7 short, reusable THEMES running through the call; reuse a prior quarter's theme label whenever the same topic recurs (labels are cross-quarter join keys).",
  "Compactness is the DISPLAY's job, never yours — never omit content to save space.",
  "Output only the schema.",
].join(" ");

/* ============================================================================
   Key-figures completeness ("double-check") pass.
   Single-pass extraction from a long source is incomplete and varies run to run
   (RELIANCE swung 27->22->18 key_figures on the same quarter across runs). This
   SECOND focused pass re-reads the SOURCE hunting ONLY for numbers MISSING from
   the first pass, and merges them back. Client rule: never lose data. Safe by
   construction — it only ADDS figures (deduped by label+value), never removes;
   on any error it returns the input unchanged. Gated by FIGURES_COMPLETENESS
   (set 0 to disable). Runs up to `maxRounds` times, stopping once a round finds
   nothing new (best-quality recall for a couple of cheap, focused calls).
   ========================================================================== */
const MISSING_FIGURE = {
  type: "object",
  additionalProperties: false,
  required: ["section_id", "label", "value", "unit", "period", "kind"],
  properties: {
    section_id: { type: "string", enum: SECTION_IDS },
    label: { type: "string" },
    value: { type: "string", description: "Exact figure as stated in the source." },
    unit: { type: ["string", "null"] },
    period: { type: ["string", "null"] },
    kind: { type: "string", enum: ["reported", "guidance", "target", "market_size"] },
  },
};
const COMPLETION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["missing"],
  properties: { missing: { type: "array", items: MISSING_FIGURE } },
};
const COMPLETION_SYSTEM = [
  "You are a meticulous fact-checker for equity-research extraction.",
  "You are given a company's earnings-call SOURCE TEXT and the list of key_figures ALREADY extracted from it.",
  "Your ONLY job: return every quantitative disclosure that is present in the SOURCE but MISSING from the extracted list. Be exhaustive — you are the safety net against lost data.",
  "Treat a figure as MISSING unless the same metric with the same value is already in the extracted list (ignore trivial wording differences in the label).",
  "A figure's VALUE must be a genuine QUANTITY — a number, percentage, currency amount, ratio, multiple, or count. Do NOT return qualitative statements, product or feature names, or narrative descriptions as figures; those belong in prose, not the numbers table.",
  "Hunt operational metrics as hard as financial ones: subscriber / customer / user / member counts, ARPU, net adds, churn, volumes, realizations, usage, utilization, occupancy, order book / backlog / pipeline, store / outlet counts, capacity, patents, and ANY per-segment or per-brand number — alongside every financial figure (revenue, growth, EBITDA, margins, PAT, debt, capex, ratios).",
  "CONSOLIDATED vs STANDALONE: if a metric appears on both bases, only the consolidated value belongs — do NOT surface the standalone duplicate as missing.",
  "For each missing figure return its value EXACTLY as stated, its unit and period if stated (else null), its kind, and the section id it best fits by MEANING.",
  "Never invent a number, and never return one already in the list. If nothing is missing, return an empty list.",
  "Output only the schema.",
].join(" ");

/** Loose key for de-duping a figure across passes (normalized label + value). */
function figKey(f) {
  const l = String(f.label || "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
  const v = String(f.value || "").toLowerCase().replace(/[\s,]+/g, "");
  return `${l}|${v}`;
}

/**
 * One completeness round: find figures in `rawText` missing from `sections` and
 * merge them into their best-fit section. Only ADDS (deduped by label+value);
 * never removes. Returns { sections, added }. Any error -> input unchanged, added 0.
 */
export async function completeKeyFiguresOnce(sections, rawText, meta = {}) {
  if (!Array.isArray(sections) || !sections.length || !rawText) return { sections, added: 0 };
  const existing = sections.flatMap((s) =>
    (s.key_figures || []).map((f) => `${f.label} = ${f.value}${f.period ? " (" + f.period + ")" : ""}`)
  );
  const user = [
    `COMPANY: ${meta.company || meta.ticker || ""}`,
    "ALREADY-EXTRACTED key_figures — do NOT return any of these again:",
    existing.length ? existing.join("\n") : "(none yet)",
    "",
    "SOURCE TEXT — return every number in here that is missing from the list above:",
    String(rawText).slice(0, 80000),
  ].join("\n");

  let missing;
  try {
    const out = await openaiStructured({ system: COMPLETION_SYSTEM, user, schemaName: "missing_figures", schema: COMPLETION_SCHEMA });
    missing = Array.isArray(out.missing) ? out.missing : [];
  } catch (e) {
    console.log(`[completeness] pass skipped for ${meta.ticker || "?"}: ${e.message}`);
    return { sections, added: 0 };
  }

  const byId = new Map(sections.map((s) => [s.id, s]));
  const seen = new Set(sections.flatMap((s) => (s.key_figures || []).map(figKey)));
  let added = 0;
  for (const m of missing) {
    if (!m || !m.value) continue;
    const key = figKey(m);
    if (seen.has(key)) continue; // already captured — never duplicate
    seen.add(key);
    let sec = byId.get(m.section_id);
    if (!sec) {
      const def = SECTIONS.find((x) => x.id === m.section_id);
      if (!def) continue; // unknown section id -> skip (can't misfile)
      sec = { id: def.id, title: def.title, key_figures: [], subsections: [] };
      byId.set(sec.id, sec);
      sections.push(sec);
    }
    (sec.key_figures ||= []).push({
      label: m.label,
      value: m.value,
      unit: m.unit ?? null,
      period: m.period ?? null,
      kind: m.kind,
    });
    added++;
  }
  sections.sort((a, b) => SECTION_IDS.indexOf(a.id) - SECTION_IDS.indexOf(b.id));
  return { sections, added };
}

/** Max source chars per completeness call. A whole 50-80k transcript asked for
 *  "every missing number" at once overflows the model's response (observed:
 *  "Unterminated string in JSON at position 61748"), which throws away the entire
 *  round. Chunking bounds each answer so nothing is lost to truncation. */
const COMPLETION_CHUNK_CHARS = 24000;
const COMPLETION_CHUNK_OVERLAP = 500; // so a number split across a boundary is still seen

/** Split text into overlapping chunks, preferring paragraph boundaries. */
function chunkText(text, size = COMPLETION_CHUNK_CHARS, overlap = COMPLETION_CHUNK_OVERLAP) {
  const s = String(text || "");
  if (s.length <= size) return s ? [s] : [];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      // back off to the last paragraph/sentence break in the final 20% of the window
      const win = s.slice(i, end);
      const cut = Math.max(win.lastIndexOf("\n\n"), win.lastIndexOf("\n"), win.lastIndexOf(". "));
      if (cut > size * 0.8) end = i + cut;
    }
    out.push(s.slice(i, end));
    if (end >= s.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

/**
 * Run the completeness pass over the whole source, chunking long text so no
 * response is lost to truncation. Each chunk sees the figures recovered so far,
 * so overlaps and repeats de-dupe instead of piling up. Short sources may repeat
 * a round until nothing new appears. Only ADDS; on any error whatever has been
 * recovered so far is kept (never worse than the first pass).
 */
export async function completeKeyFigures(sections, rawText, meta = {}, maxRounds = 2) {
  const chunks = chunkText(rawText);
  if (!chunks.length) return sections;
  let cur = sections;
  let total = 0;
  // A chunked source is already swept piece by piece — one pass per chunk. A
  // single-chunk source is cheap, so let it repeat until it converges.
  const rounds = chunks.length > 1 ? 1 : maxRounds;
  for (const chunk of chunks) {
    for (let r = 1; r <= rounds; r++) {
      const { sections: next, added } = await completeKeyFiguresOnce(cur, chunk, meta);
      cur = next;
      total += added;
      if (!added) break; // converged for this chunk
    }
  }
  if (total) {
    console.log(
      `[completeness] ${meta.ticker || "?"} @ ${meta.concall_date || "?"}: +${total} figure(s) recovered` +
        (chunks.length > 1 ? ` (${chunks.length} chunks)` : "")
    );
  }
  return cur;
}

/**
 * Organize ONE quarter's scraped summary into the schema.
 *
 * @param {object} scrape   result from scrape-screener.mjs (one quarter)
 * @param {object|null} priorGuidance  the prior quarter's guidance_ledger (for context)
 * @returns {Promise<object>} { summary, sections, guidance_ledger, risk_register, key_takeaways, pressing_questions, model }
 */
export async function classifyQuarter(scrape, priorGuidance = null, priorThemes = null) {
  const sectionMenu = SECTIONS.map((s) => `${s.id} — ${s.title}: ${s.scope}`).join("\n");

  const takeaways = (scrape.key_takeaways || []).filter(Boolean);
  const questions = (scrape.pressing_questions || []).filter(Boolean);

  const priorContext = priorGuidance?.length
    ? `\n\nPRIOR QUARTER GUIDANCE (for direction context only; do not invent deltas):\n${JSON.stringify(
        priorGuidance.map((g) => ({ metric: g.metric, statement: g.statement, horizon: g.horizon })),
        null,
        2
      )}`
    : "";

  const priorThemesContext = priorThemes?.length
    ? `\n\nPRIOR QUARTER THEME LABELS (reuse these EXACT labels when the same topic recurs, so themes track across quarters):\n${priorThemes
        .map((t) => `- ${t.label}`)
        .join("\n")}`
    : "";

  const user = [
    `COMPANY: ${scrape.company || scrape.ticker}`,
    `TICKER: ${scrape.ticker}`,
    `CONCALL DATE: ${scrape.concall_date || "unknown"}`,
    `SOURCE: ${scrape.source}`,
    "",
    "THE 11 SECTIONS (move each disclosure into exactly one best-fit id; preserve ALL detail):",
    sectionMenu,
    "",
    takeaways.length
      ? "SCREENER KEY TAKEAWAYS (copy these into key_takeaways VERBATIM — do not reword):\n" +
        takeaways.map((t) => `- ${t}`).join("\n")
      : "SCREENER KEY TAKEAWAYS: not separately extracted. If the CONCALL SUMMARY TEXT below contains an explicit 'Key Takeaways' / 'Highlights' block, reproduce those bullets VERBATIM. OTHERWISE select the 5-8 MOST MATERIAL takeaways in the source's own words — do NOT treat every sentence, heading or section as a takeaway (this is a scannable digest; the full detail already lives in the sections).",
    "",
    questions.length
      ? "PRESSING / HIGHLIGHTED QUESTIONS (copy into pressing_questions):\n" +
        questions.map((q) => `- ${q}`).join("\n")
      : "PRESSING / HIGHLIGHTED QUESTIONS: if the summary highlights unanswered/pressing analyst questions, reproduce them into pressing_questions.",
    "",
    "CONCALL SUMMARY TEXT — REORGANIZE this into the sections and PRESERVE every disclosure (every number into key_figures with unit+period; every thematic detail into subsections). Keep the source's headings/labels where possible. Do NOT summarize it further:",
    scrape.raw_text || "(none)",
    "",
    "THEMES: also surface 3-7 short, reusable themes running through this call — each with a direction (positive/negative/neutral/mixed), a one-line note faithful to the source, and the section it ties to. Keep labels short and reusable so they track across quarters.",
    priorContext,
    priorThemesContext,
  ].join("\n");

  const out = await openaiStructured({
    system: SYSTEM_PROMPT,
    user,
    schemaName: "concall_tearsheet",
    schema: SCHEMA,
  });

  // Sort sections into the canonical fixed order (consistency across quarters).
  out.sections = (out.sections || [])
    .filter((s) => SECTION_IDS.includes(s.id))
    .sort((a, b) => SECTION_IDS.indexOf(a.id) - SECTION_IDS.indexOf(b.id));

  // Completeness ("double-check") pass — for EVERY source. A single extraction
  // pass is incomplete and varies run to run on both condensed summaries AND long
  // transcripts (a refresh moved HEROMOTOCO 45->28 and EICHERMOT 35->21 figures on
  // transcript sources alone), so re-read the source and recover what it missed.
  // Long text is chunked, which is what makes transcripts safe here.
  // Only ADDS (deduped) — can never lose a first-pass figure.
  if (process.env.FIGURES_COMPLETENESS !== "0") {
    out.sections = await completeKeyFigures(out.sections, scrape.raw_text, {
      company: scrape.company,
      ticker: scrape.ticker,
      concall_date: scrape.concall_date,
    });
  }

  // Preserve the source's Key Takeaways / questions VERBATIM. The dashboard
  // labels them "Screener · verbatim", so overwrite the model's arrays with the
  // scraped originals whenever the source provided them (no paraphrasing).
  if (Array.isArray(scrape.key_takeaways) && scrape.key_takeaways.length) {
    out.key_takeaways = scrape.key_takeaways.slice(); // Screener's own digest, verbatim
  } else {
    // No explicit Key Takeaways block in the source: the model derived them from
    // the summary and can over-extract (e.g. dumping the whole summary line by
    // line — 76 "takeaways" observed). Bound to a scannable digest; no real
    // disclosure is lost because the full detail lives in the sections.
    out.key_takeaways = (out.key_takeaways || []).filter(Boolean).slice(0, 12);
  }
  if (Array.isArray(scrape.pressing_questions) && scrape.pressing_questions.length) {
    out.pressing_questions = scrape.pressing_questions.slice();
  }

  // Normalize model artifacts: a literal "null"/"" unit or period -> real null.
  const clean = (v) => {
    const s = (v ?? "").toString().trim();
    return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined" ? s : null;
  };
  for (const sec of out.sections) {
    for (const f of sec.key_figures || []) {
      f.unit = clean(f.unit);
      f.period = clean(f.period);
    }
  }

  // Diagnostic: how rich did this come out? Empty takeaways/thin output show here.
  const kfCount = (out.sections || []).reduce((n, s) => n + (s.key_figures?.length || 0), 0);
  console.log(
    `[classify] ${scrape.ticker} @ ${scrape.concall_date || "?"} (${MODEL}): ` +
      `sections=${out.sections.length} keyFigures=${kfCount} ` +
      `guidance=${out.guidance_ledger?.length || 0} risks=${out.risk_register?.length || 0} ` +
      `takeaways=${out.key_takeaways?.length || 0} questions=${out.pressing_questions?.length || 0} ` +
      `themes=${out.themes?.length || 0}`
  );

  out.model = MODEL;
  return out;
}

/* ============================================================================
   Governing "editor" pass.
   Client: "put one governing LLM on top of this which removes all redundant
   information ... it needs to just ruthlessly remove everything." A SECOND model
   call that curates ONLY the prose points — dedupes, drops bare restatements &
   filler, fixes incoherent causal claims, re-files each point by MEANING and
   ranks most-important-first. It never returns key_figures: those are re-attached
   from the first pass, so NO number can be lost. Best-effort: any failure returns
   the first-pass sections unchanged (never worse than today).
   ========================================================================== */
const EDITED_SECTION = {
  type: "object",
  additionalProperties: false,
  required: ["id", "subsections"],
  properties: {
    id: { type: "string", enum: SECTION_IDS },
    subsections: SCHEMA.properties.sections.items.properties.subsections,
  },
};
const EDITED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: { sections: { type: "array", items: EDITED_SECTION } },
};

const EDITOR_SYSTEM = [
  "You are a meticulous equity-research EDITOR. You are given a company's earnings-call tear sheet already organized into sections, each with a key_figures table (for CONTEXT only) and prose 'points'.",
  "Return ONLY the curated prose (subsections) for each section — never the key_figures.",
  "OVERRIDING RULE — PRESERVE INFORMATION. The ONLY thing you strip out is repetition; keep all the qualitative detail. Losing a specific fact is far worse than leaving some repetition. When in ANY doubt about a point, KEEP IT. A little redundancy is acceptable; dropping information is not. Bias heavily toward keeping.",
  "You may remove a point ONLY when it repeats information already present, i.e. one of these two cases:",
  "1. It is a near-verbatim DUPLICATE of another point you are keeping (same fact, no new specific) — keep one copy, drop the exact duplicate.",
  "2. It does NOTHING but restate a number already in this section's key_figures AND adds no driver, cause, comparison, or any other specific. If it adds even a little 'why' or any extra detail, KEEP it.",
  "NEVER drop a point that carries a unique number, named entity, date, place, product, brand, segment, KPI, or causal driver that is not already present in a point you keep. If you are unsure whether a detail is unique, treat it as unique and KEEP the point.",
  "Do NOT compress, merge-away, or shorten points to save space — fidelity to the source's specifics is the goal, not compactness.",
  "If a causal claim is plainly self-contradictory, correct it to what the source supports — do not drop the underlying fact.",
  "You SHOULD still improve ORGANIZATION, which never removes information: put each point in the section that fits its MEANING (a telecom/digital-services business point belongs in Segment & Product Performance, not Product & Technology; a green-energy capacity note belongs in Manufacturing & Capacity), and order the sections and the points within each MOST-IMPORTANT FIRST.",
  "PRESERVE every specific number, named entity and distinct fact. Reuse the source's own sub-topic labels. Output only the schema.",
].join(" ");

/**
 * Governing editor pass over ONE quarter's sections. Curates prose only;
 * key_figures are preserved verbatim from the input. Returns edited sections in
 * canonical order. On any error, returns the input sections unchanged.
 */
export async function editTearSheet(sections, meta = {}) {
  if (!Array.isArray(sections) || !sections.length) return sections;
  const hasProse = sections.some((s) => (s.subsections || []).some((x) => x.points?.length));
  if (!hasProse) return sections; // nothing to curate

  const user = [
    `COMPANY: ${meta.company || meta.ticker || ""}`,
    "The tear sheet's sections follow as JSON (key_figures included for context — do NOT return them).",
    "Return the curated subsections for each section per the rules.",
    JSON.stringify({ sections }, null, 2),
  ].join("\n");

  let editedById;
  try {
    const out = await openaiStructured({ system: EDITOR_SYSTEM, user, schemaName: "edited_tearsheet", schema: EDITED_SCHEMA });
    editedById = new Map((out.sections || []).map((s) => [s.id, (s.subsections || []).filter((x) => x.points?.length)]));
  } catch (e) {
    console.log(`[editor] pass skipped for ${meta.ticker || "?"}: ${e.message}`);
    return sections;
  }

  const origIds = new Set(sections.map((s) => s.id));
  // Preserve every section + its key_figures; swap in curated prose where returned.
  const result = sections.map((s) => ({ ...s, subsections: editedById.get(s.id) ?? s.subsections }));
  // A point the editor re-filed INTO a section that had no prose before.
  for (const [id, subs] of editedById) {
    if (!origIds.has(id) && subs.length) {
      const m = SECTIONS.find((x) => x.id === id);
      if (m) result.push({ id, title: m.title, key_figures: [], subsections: subs });
    }
  }
  result.sort((a, b) => SECTION_IDS.indexOf(a.id) - SECTION_IDS.indexOf(b.id));
  const kfKept = result.reduce((n, s) => n + (s.key_figures?.length || 0), 0);
  console.log(`[editor] ${meta.ticker || "?"}: sections ${sections.length}→${result.length}, key_figures preserved=${kfKept}`);
  return result;
}

/* ============================================================================
   Deterministic guidance-vs-delivery diff.
   Statuses are computed in CODE from the prior quarter's ledger — not the model.
   First tracked quarter -> everything "new".
   ========================================================================== */

/** Normalize a metric name for matching across quarters. */
function normMetric(s = "") {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\b(guidance|target|of|the|for|to|a|an|in|by|growth|approximately|about|around)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the guidance TARGET value, ignoring fiscal-year / quarter / calendar
 * tokens (FY25, Q1, H2, 2026) that would otherwise be misread as the value.
 * Prefers a percentage, else the first remaining number.
 */
function targetNumber(s = "") {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/\bFY\s?\d{2,4}\b/gi, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/\bH[12]\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  const pct = cleaned.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (pct) return parseFloat(pct[1]);
  const num = cleaned.match(/-?\d+(?:\.\d+)?/);
  return num ? parseFloat(num[0]) : null;
}

/** Normalize a risk description for matching across quarters. */
function normRisk(s = "") {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(risk|risks|of|the|to|a|an|in|by|and|due|from)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finalize guidance statuses for `current` relative to `prior`.
 * Mutates+returns a new ledger. Prior items absent this quarter are appended
 * as "no_mention" so dropped guidance stays visible.
 */
export function diffGuidance(current = [], prior = null) {
  const cur = (current || []).map((g) => ({ ...g }));

  // First tracked quarter (or no prior): everything is new.
  if (!prior || !prior.length) {
    for (const g of cur) g.status = "new";
    return cur;
  }

  const priorByKey = new Map();
  for (const p of prior) priorByKey.set(normMetric(p.metric), p);
  const matchedPriorKeys = new Set();

  for (const g of cur) {
    const key = normMetric(g.metric);
    // exact normalized match, else fuzzy contains match
    let match = priorByKey.get(key);
    if (!match) {
      for (const [pk, pv] of priorByKey) {
        if (pk && (pk.includes(key) || key.includes(pk))) {
          match = pv;
          break;
        }
      }
    }
    if (!match) {
      g.status = "new";
      continue;
    }
    matchedPriorKeys.add(normMetric(match.metric));

    // Preserve an explicit delivery outcome the model read from the call text
    // (grounded in a tracked prior guidance); otherwise compute the numeric
    // delta from the target values (fiscal-year tokens excluded).
    if (["achieved", "missed", "pushed_out", "dropped"].includes(g.status)) {
      // keep the model's delivery status
    } else {
      const cn = targetNumber(g.statement) ?? targetNumber(g.metric);
      const pn = targetNumber(match.statement) ?? targetNumber(match.metric);
      if (cn != null && pn != null && cn !== pn) {
        g.status = cn > pn ? "raised" : "lowered";
      } else {
        g.status = "reiterated";
      }
    }
  }

  // Prior guidance not mentioned this quarter -> keep it visible as no_mention.
  for (const p of prior) {
    if (!matchedPriorKeys.has(normMetric(p.metric))) {
      cur.push({
        metric: p.metric,
        horizon: p.horizon ?? null,
        statement: p.statement,
        specificity: p.specificity || "vague",
        direction: p.direction || "unclear",
        status: "no_mention",
      });
    }
  }

  return cur;
}

/**
 * Deterministic risk-register diff across quarters (mirrors diffGuidance).
 * Matched risks keep the model's escalated/easing/resolved delta or default to
 * "stable"; unmatched current risks -> "new"; prior risks absent this quarter
 * are appended as "no_mention" so they don't silently vanish.
 * First tracked quarter (no prior) -> everything "new".
 */
export function diffRisks(current = [], prior = null) {
  const cur = (current || []).map((r) => ({ ...r }));

  if (!prior || !prior.length) {
    for (const r of cur) if (!r.status || r.status === "no_mention") r.status = "new";
    return cur;
  }

  const priorByKey = new Map();
  for (const p of prior) priorByKey.set(normRisk(p.risk), p);
  const matched = new Set();

  for (const r of cur) {
    const key = normRisk(r.risk);
    let m = priorByKey.get(key);
    if (!m) {
      for (const [pk, pv] of priorByKey) {
        if (pk && (pk.includes(key) || key.includes(pk))) {
          m = pv;
          break;
        }
      }
    }
    if (m) {
      matched.add(normRisk(m.risk));
      // keep an explicit escalation/easing/resolution the model read; else stable
      if (!["escalated", "easing", "resolved"].includes(r.status)) r.status = "stable";
    } else {
      r.status = "new";
    }
  }

  for (const p of prior) {
    if (!matched.has(normRisk(p.risk))) {
      cur.push({ risk: p.risk, status: "no_mention", note: p.note ?? null });
    }
  }

  return cur;
}
