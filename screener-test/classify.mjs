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
  "subsections must carry the real thematic detail as full points (reuse the source's own headings as labels where possible), not one-line boil-downs.",
  "Reproduce the source's Key Takeaways, and any highlighted/unanswered questions, VERBATIM — do not reword, shorten or drop them. If the summary text contains a Key Takeaways / Highlights block, copy those bullets exactly.",
  "Also surface 3-7 short, reusable THEMES running through the call; reuse a prior quarter's theme label whenever the same topic recurs (labels are cross-quarter join keys).",
  "Compactness is the DISPLAY's job, never yours — never omit content to save space.",
  "Output only the schema.",
].join(" ");

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
