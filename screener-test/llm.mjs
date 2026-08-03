/**
 * llm.mjs — thin clients for the analysis engine.
 * =================================================
 *   - llmStructured(): ONE structured-JSON call, served by whichever LLM
 *     provider is configured. Two providers are supported and they are
 *     interchangeable at this seam:
 *
 *       bedrock  Claude (Anthropic) via Claude in Amazon Bedrock, using the
 *                Messages API at /anthropic/v1/messages with a bearer token
 *                (BEDROCK_API_KEY) in the x-api-key header. Structured output
 *                via output_config.format = json_schema.
 *       openai   OpenAI Chat Completions with Structured Outputs
 *                (response_format json_schema, strict), temperature 0.
 *
 *     Same fallback shape as the Screener credentials: primary provider first,
 *     the other one automatically as backup, so a dead key never kills a run.
 *     The model ORGANIZES the provided summary into our schema; it does not opine.
 *
 *   - firecrawlScrape(): fallback fetch for pages/PDFs that block direct access
 *     (exchange PDFs hotlink-block). Returns extracted text (markdown).
 *
 * Node 22 (global fetch). All secrets come from env — nothing is hardcoded.
 */

/** OPENAI_BASE_URL points at an OpenAI-compatible endpoint (proxy / test stub). */
const OPENAI_URL = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

/* ============================================================================
   Provider selection.

   Default order is Bedrock first (that is the key with balance today), OpenAI
   as the automatic backup. Set LLM_PROVIDER=openai to flip it back once the
   OpenAI account is topped up — nothing else has to change.
   ========================================================================== */

const hasBedrock = () => !!process.env.BEDROCK_API_KEY;
const hasOpenAI = () => !!process.env.OPENAI_API_KEY;

/** Preferred provider: explicit env, else Bedrock if its key exists, else OpenAI. */
export const PROVIDER =
  (process.env.LLM_PROVIDER || "").trim().toLowerCase() ||
  (hasBedrock() ? "bedrock" : "openai");

/** OpenAI model. gpt-4o has Structured Outputs and handles the (short) summaries. */
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

/**
 * Bedrock model IDs carry an `anthropic.` provider prefix. Sonnet 5 leads on
 * measurement, not on tier: re-running BPCL through both, Sonnet captured 100%
 * of the numbers Opus 4.8 found on the AI summary (plus 4 more) in a third of
 * the wall-clock time. That is the path this pipeline is on — the client's
 * source of record is Screener's AI summary.
 *
 * The gap shows on long TRANSCRIPTS, where Sonnet found 86% of Opus's numbers.
 * Transcripts are the fallback for a call Screener has not summarised yet, and
 * mergeQuarters replaces them with the summary once it lands — so the weaker
 * case is also the temporary one. If Screener stays slow to publish summaries,
 * revisit this: set BEDROCK_MODEL to pin a different model, no code change.
 *
 * Opus 4.8 stays as the fallback for an account that cannot reach Sonnet.
 */
const BEDROCK_MODEL_CHAIN = process.env.BEDROCK_MODEL
  ? [process.env.BEDROCK_MODEL]
  : ["anthropic.claude-sonnet-5", "anthropic.claude-opus-4-8"];

/** Claude in Amazon Bedrock region. Global endpoint; us-east-1 is the safe default. */
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

/** Output ceiling, and how far it may grow.
 *  A tear sheet with 137 key figures is genuinely long JSON, and a fixed 16k
 *  ceiling truncated two companies outright on the first real run — the model
 *  was fine, the budget was not. Rather than hard-code a number that depends on
 *  the model, start here and let a truncation raise it (see bedrockStructured).
 *  A too-LARGE value is rejected outright by the API, so it also steps back
 *  down; either way the process settles on a value that works and keeps it. */
const BEDROCK_MAX_TOKENS = parseInt(process.env.BEDROCK_MAX_TOKENS || "", 10) || 16384;
const BEDROCK_MAX_TOKENS_CEILING =
  parseInt(process.env.BEDROCK_MAX_TOKENS_CEILING || "", 10) || 65536;

/** Extended thinking is off by default: this is faithful extraction, not reasoning,
 *  and thinking tokens are billed. BEDROCK_THINKING=1 turns it on. */
const BEDROCK_THINKING = process.env.BEDROCK_THINKING === "1";

/** The model that actually served the last successful call — recorded in the JSON
 *  so every quarter says which model produced it. */
let activeModelId = PROVIDER === "bedrock" ? BEDROCK_MODEL_CHAIN[0] : OPENAI_MODEL;

/** Resolved once per process, after the first successful Bedrock call. */
let resolvedBedrockModel = null;

/** The model in use right now (provider-aware). */
export function activeModel() {
  return activeModelId;
}

/** Small sleep for retry backoff. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================
   Claude via Amazon Bedrock.
   ========================================================================== */

/** Endpoint pattern for Claude in Amazon Bedrock (Messages API shape).
 *  BEDROCK_BASE_URL overrides the host (used by the offline stream test). */
const bedrockUrl = () =>
  process.env.BEDROCK_BASE_URL
    ? `${process.env.BEDROCK_BASE_URL.replace(/\/$/, "")}/v1/messages`
    : `https://bedrock-mantle.${BEDROCK_REGION}.api.aws/anthropic/v1/messages`;

/** An error we should not retry and should not blame on the network. */
class BedrockModelAccessError extends Error {}
/** The request shape this deployment won't accept — try the next one. */
class BedrockShapeError extends Error {}
/** The answer didn't fit in max_tokens — retry with more room. */
class BedrockTruncatedError extends Error {}
/** This model won't accept a budget that large — step back down. */
class BedrockBudgetTooLargeError extends Error {}
/** Valid JSON, wrong shape — the model deviated from the schema. Retryable. */
class BedrockBadShapeError extends Error {}

/**
 * Shallow check that a parsed answer matches the schema we asked for.
 *
 * Only the top level, and only what actually breaks callers: a missing required
 * key, or an array field that came back as something else. Two companies died on
 * "(out.sections || []).filter is not a function" — valid JSON, but `sections`
 * was not a list, so every downstream `.filter`/`.map` threw and the company was
 * lost. Catching it here turns that into a retry, which usually succeeds,
 * instead of a dead company.
 *
 * Deliberately NOT a full JSON Schema validator: the strict shapes already
 * enforce the details, and a half-written one would reject good answers.
 */
function schemaMismatch(obj, schema) {
  if (!schema || schema.type !== "object") return null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "top level is not an object";
  for (const k of schema.required || []) {
    if (!(k in obj)) return `missing required key "${k}"`;
  }
  for (const [k, spec] of Object.entries(schema.properties || {})) {
    if (!(k in obj) || obj[k] == null) continue;
    if (spec?.type === "array" && !Array.isArray(obj[k])) return `"${k}" should be an array`;
    if (spec?.type === "object" && (typeof obj[k] !== "object" || Array.isArray(obj[k])))
      return `"${k}" should be an object`;
  }
  return null;
}

/**
 * How to ask for schema-constrained JSON. There is more than one way and which
 * ones a given Bedrock deployment accepts is not knowable from here, so we try
 * them in order and remember the one that works (see `resolvedShape`).
 *
 *   json_schema   the documented Structured Outputs parameter. First choice.
 *   strict_tool   one tool, forced; `strict` guarantees schema adherence.
 *   tool          same, without `strict`, for deployments that reject it.
 *
 * All three return the same object, so nothing downstream knows the difference.
 */
const SHAPES = [
  {
    name: "json_schema",
    // Structured Outputs puts the JSON in a normal text block.
    delta: "text_delta",
    apply: (body, schema) => {
      body.output_config = { format: { type: "json_schema", schema } };
    },
  },
  {
    name: "strict_tool",
    // Tool input streams as input_json_delta, NOT as text.
    delta: "input_json_delta",
    apply: (body, schema, toolName) => {
      body.tools = [
        { name: toolName, description: "Return the result in this exact shape.", input_schema: schema, strict: true },
      ];
      body.tool_choice = { type: "tool", name: toolName };
    },
  },
  {
    name: "tool",
    delta: "input_json_delta",
    apply: (body, schema, toolName) => {
      body.tools = [
        { name: toolName, description: "Return the result in this exact shape.", input_schema: schema },
      ];
      body.tool_choice = { type: "tool", name: toolName };
    },
  },
];

/** Does this 400 mean "wrong request shape" rather than "bad content"? */
const isShapeRejection = (text) =>
  /output_config|output_format|input_schema|tool_choice|\btools\b|\bstrict\b/i.test(text);

/** Set once the deployment tells us which shape it accepts. */
let resolvedShape = null;
/** Output budget in use. Grows on truncation, shrinks if the API rejects it,
 *  and persists for the rest of the process so the cost is paid once. */
let maxTokensInUse = BEDROCK_MAX_TOKENS;
/** Hard upper bound. Starts at the configured ceiling and drops the moment a
 *  model refuses a value, so growing and shrinking can never fight each other:
 *  without this, a model that rejects 16k while truncating at 8k would flap
 *  between the two until the attempts ran out. */
let maxTokensLimit = BEDROCK_MAX_TOKENS_CEILING;

/**
 * One streaming Bedrock call. Streaming (rather than a single blocking POST)
 * is deliberate: a full tear sheet can take minutes to generate and a
 * non-streaming request would sit silent long enough to trip request timeouts.
 *
 * @returns {Promise<string>} the accumulated JSON document.
 */
async function bedrockOnce({ model, system, user, schema, schemaName, shape, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    stream: true,
  };
  shape.apply(body, schema, schemaName || "emit_result");
  // NOTE: no `temperature`. Sampling parameters are rejected (400) on Opus 5 /
  // Opus 4.8 / 4.7, which is why determinism here comes from the schema, not
  // from temperature 0 as on the OpenAI path.
  if (BEDROCK_THINKING) body.thinking = { type: "adaptive" };

  const res = await fetch(bedrockUrl(), {
    method: "POST",
    headers: {
      "x-api-key": process.env.BEDROCK_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    // Backstop only — the stream keeps the connection alive, so this should
    // never fire on a healthy call.
    signal: AbortSignal.timeout(900000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Bedrock ${res.status}: ${text.slice(0, 600)}`);
    // ORDER MATTERS. Classify by the SPECIFIC parameter named first, because the
    // model-access test below matches the bare word "model" — and a budget
    // rejection reads "max_tokens ... exceeds the maximum for this model", so
    // checking access first misfiles it and walks the model chain pointlessly.
    if (res.status === 400 && /max_tokens/i.test(text)) {
      throw Object.assign(new BedrockBudgetTooLargeError(err.message), { status: res.status });
    }
    if (res.status === 400 && isShapeRejection(text)) {
      throw Object.assign(new BedrockShapeError(err.message), { status: res.status });
    }
    // A model this account cannot reach (or an unknown model ID) is a config
    // problem, not a transient one — signal it so we can try the next model.
    if (res.status === 403 || res.status === 404 || (res.status === 400 && /model/i.test(text))) {
      throw Object.assign(new BedrockModelAccessError(err.message), { status: res.status });
    }
    throw Object.assign(err, { status: res.status });
  }

  // ---- SSE: accumulate text deltas into the JSON document. -----------------
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  let stopReason = null;
  let streamError = null;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // `event:` lines carry no payload
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // a partial frame; the next chunk completes it
      }
      // Take ONLY the delta type this shape produces. Accepting both meant a
      // model that prefaces a tool call with a sentence of text ("Here is the
      // analysis...") concatenated that sentence onto the tool's JSON.
      if (ev.type === "content_block_delta" && ev.delta?.type === shape.delta) {
        out += shape.delta === "text_delta" ? ev.delta.text : ev.delta.partial_json;
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        streamError = ev.error?.message || JSON.stringify(ev.error);
      }
    }
  }

  if (streamError) throw new Error(`Bedrock stream error: ${streamError}`);
  if (stopReason === "max_tokens") {
    // Truncated JSON cannot parse. Typed so the caller can simply give it more
    // room and try again, instead of failing the company.
    throw new BedrockTruncatedError(`Bedrock hit max_tokens (${maxTokens}) — output truncated`);
  }
  if (!out.trim()) throw new Error("Bedrock returned empty content");
  return out;
}

/**
 * Bedrock with retries, plus a one-time walk down two axes: which MODEL this
 * account can reach, and which request SHAPE this deployment accepts. Both are
 * resolved on the first call and pinned for the rest of the process, so the
 * probing costs at most a couple of cheap rejected requests per run.
 */
async function bedrockStructured({ system, user, schema, schemaName }) {
  if (!process.env.BEDROCK_API_KEY) throw new Error("BEDROCK_API_KEY is not set");

  const models = resolvedBedrockModel ? [resolvedBedrockModel] : BEDROCK_MODEL_CHAIN;
  const shapes = resolvedShape ? [resolvedShape] : SHAPES;
  let lastErr;

  for (const model of models) {
    let modelUnreachable = false;
    for (const shape of shapes) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const text = await bedrockOnce({
            model, system, user, schema, schemaName, shape, maxTokens: maxTokensInUse,
          });
          const parsed = JSON.parse(text);
          const bad = schemaMismatch(parsed, schema);
          if (bad) throw new BedrockBadShapeError(`Bedrock returned ${bad}`);
          if (!resolvedShape) console.log(`[llm] bedrock output shape: ${shape.name}`);
          resolvedBedrockModel = model;
          resolvedShape = shape;
          activeModelId = model;
          return parsed;
        } catch (err) {
          lastErr = err;
          if (err instanceof BedrockModelAccessError) {
            modelUnreachable = true; // no shape will help — next model
            break;
          }
          if (err instanceof BedrockShapeError) break; // next shape, same model
          // The model wandered off the schema. Same request again usually lands
          // it; only give up once the attempts are spent.
          if (err instanceof BedrockBadShapeError) {
            console.warn(`[llm] ${err.message} — retrying`);
            if (attempt === 5) throw err;
            continue;
          }
          // A long tear sheet simply needs more room. Double and retry rather
          // than failing the company, and keep the larger budget for the rest
          // of the run so the next long one doesn't pay the same wasted call.
          if (err instanceof BedrockTruncatedError) {
            // Already at the most this model will take: more room is not on
            // offer, so report it rather than flapping.
            if (maxTokensInUse >= maxTokensLimit) throw err;
            maxTokensInUse = Math.min(maxTokensInUse * 2, maxTokensLimit);
            console.warn(`[llm] output truncated — raising max_tokens to ${maxTokensInUse} and retrying`);
            continue;
          }
          // The other direction: too large for this model. Halve and retry.
          if (err instanceof BedrockBudgetTooLargeError) {
            const next = Math.floor(maxTokensInUse / 2);
            if (next < 4096) throw err;
            maxTokensLimit = maxTokensInUse - 1; // never ask for this much again
            maxTokensInUse = next;
            console.warn(`[llm] max_tokens rejected — lowering to ${maxTokensInUse} and retrying`);
            continue;
          }
          const status = err.status;
          // 4xx other than 429 is a request problem — retrying changes nothing.
          if (status && status !== 429 && status < 500) throw err;
          // Transient: a timeout, a 5xx, a refused connection. Retry here, but
          // do NOT let it walk the shape and model lists afterwards — a dead
          // endpoint is neither shape- nor model-specific, and re-walking turned
          // one unreachable host into 54 attempts of escalating backoff before
          // the OpenAI fallback ever got a turn. Cap the backoff too: past a few
          // seconds it is waiting, not recovering.
          if (attempt === 5) throw err;
          await sleep(Math.min(1500 * 2 ** attempt, 8000));
        }
      }
      if (modelUnreachable) break;
    }
  }
  throw lastErr || new Error("Bedrock call failed");
}

/* ============================================================================
   OpenAI.
   ========================================================================== */

/**
 * Call OpenAI with a strict JSON schema and return the parsed object.
 * temperature: 0 for determinism. Retries transient (429/5xx) errors.
 */
async function openaiStructured({ system, user, schemaName, schema }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const body = {
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
  };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        // Bound each attempt so a stalled connection still hits the retry loop
        // (else the ticker sits "running" until GitHub's much longer job limit).
        signal: AbortSignal.timeout(120000),
      });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenAI ${res.status}: ${await res.text()}`);
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (msg?.refusal) throw new Error(`OpenAI refused: ${msg.refusal}`);
      const content = msg?.content;
      if (!content) throw new Error("OpenAI returned empty content");
      activeModelId = OPENAI_MODEL;
      return JSON.parse(content);
    } catch (err) {
      lastErr = err;
      // Only retry network-ish errors; a JSON/refusal error won't fix itself.
      if (String(err.message).includes("OpenAI 4") || String(err.message).includes("refused")) {
        throw err;
      }
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr || new Error("OpenAI call failed");
}

/* ============================================================================
   The seam the pipeline calls.
   ========================================================================== */

const RUNNERS = { bedrock: bedrockStructured, openai: openaiStructured };
const HAS_KEY = { bedrock: hasBedrock, openai: hasOpenAI };

/** Primary first, then the other provider if it has a key. */
function providerOrder() {
  const primary = RUNNERS[PROVIDER] ? PROVIDER : "openai";
  const other = primary === "bedrock" ? "openai" : "bedrock";
  return [primary, other].filter((p) => HAS_KEY[p]());
}

/**
 * One structured-JSON call, provider-agnostic.
 *
 * @param {object}   opts
 * @param {string}   opts.system      System prompt (the "organize, don't opine" rules).
 * @param {string}   opts.user        User content (the summary + context to organize).
 * @param {string}   opts.schemaName  Name for the json_schema (OpenAI only; Anthropic
 *                                    takes the schema without a name).
 * @param {object}   opts.schema      A strict JSON schema (additionalProperties:false,
 *                                    every key listed in `required`). Both providers
 *                                    require exactly that shape, so one schema serves both.
 * @returns {Promise<object>} the validated, parsed object.
 */
export async function llmStructured({ system, user, schemaName, schema }) {
  const order = providerOrder();
  if (!order.length) {
    throw new Error("No LLM key set — provide BEDROCK_API_KEY or OPENAI_API_KEY");
  }

  let firstErr;
  for (const name of order) {
    try {
      return await RUNNERS[name]({ system, user, schemaName, schema });
    } catch (err) {
      if (!firstErr) firstErr = err;
      const next = order[order.indexOf(name) + 1];
      // Never log the key; the provider name is enough to see what happened.
      console.warn(
        `[llm] ${name} failed: ${String(err.message || err).slice(0, 300)}` +
          (next ? ` — falling back to ${next}` : "")
      );
    }
  }
  throw firstErr;
}

/** One-line provider banner for the run log (no secrets). */
export function llmBanner() {
  const order = providerOrder();
  return order.length
    ? `[llm] provider=${order[0]}${order[1] ? ` (fallback: ${order[1]})` : ""} model=${activeModelId}` +
        (order[0] === "bedrock" ? ` region=${BEDROCK_REGION}` : "")
    : "[llm] no provider key set";
}

/**
 * Fetch a URL's text via Firecrawl (used when a page/PDF blocks direct access).
 * Firecrawl parses PDFs and returns markdown text.
 *
 * @param {string} url
 * @returns {Promise<{ ok:boolean, text?:string, error?:string }>}
 */
export async function firecrawlScrape(url) {
  if (!process.env.FIRECRAWL_API_KEY) {
    return { ok: false, error: "FIRECRAWL_API_KEY not set" };
  }
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 60000,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Firecrawl ${res.status}: ${await res.text()}` };
    }
    const data = await res.json();
    const text = data?.data?.markdown || data?.markdown || "";
    if (!text) return { ok: false, error: "Firecrawl returned no text" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
