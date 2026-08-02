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
 * Bedrock model IDs carry an `anthropic.` provider prefix. Opus 5 is the best
 * extractor but its Bedrock access is granted per-account, so if the account
 * cannot reach it we walk down this list once and stick with the first model
 * that answers. Set BEDROCK_MODEL to pin one explicitly.
 */
const BEDROCK_MODEL_CHAIN = process.env.BEDROCK_MODEL
  ? [process.env.BEDROCK_MODEL]
  : ["anthropic.claude-opus-5", "anthropic.claude-opus-4-8", "anthropic.claude-sonnet-5"];

/** Claude in Amazon Bedrock region. Global endpoint; us-east-1 is the safe default. */
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

/** Output ceiling. Tear sheets with 100+ key figures are long; leave headroom. */
const BEDROCK_MAX_TOKENS = parseInt(process.env.BEDROCK_MAX_TOKENS || "", 10) || 16384;

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

/**
 * One streaming Bedrock call. Streaming (rather than a single blocking POST)
 * is deliberate: a full tear sheet can take minutes to generate and a
 * non-streaming request would sit silent long enough to trip request timeouts.
 *
 * @returns {Promise<string>} the accumulated text (a JSON document, per the schema).
 */
async function bedrockOnce({ model, system, user, schema }) {
  const body = {
    model,
    max_tokens: BEDROCK_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    // Structured Outputs: the response is guaranteed to match this schema.
    output_config: { format: { type: "json_schema", schema } },
    stream: true,
  };
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
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        out += ev.delta.text;
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        streamError = ev.error?.message || JSON.stringify(ev.error);
      }
    }
  }

  if (streamError) throw new Error(`Bedrock stream error: ${streamError}`);
  if (stopReason === "max_tokens") {
    // Truncated JSON would fail to parse anyway; say why, so it is fixable.
    throw new Error(
      `Bedrock hit max_tokens (${BEDROCK_MAX_TOKENS}) — output truncated. Raise BEDROCK_MAX_TOKENS.`
    );
  }
  if (!out.trim()) throw new Error("Bedrock returned empty content");
  return out;
}

/**
 * Bedrock with retries and a one-time walk down the model chain.
 */
async function bedrockStructured({ system, user, schema }) {
  if (!process.env.BEDROCK_API_KEY) throw new Error("BEDROCK_API_KEY is not set");

  // Once a model has answered in this process, stop probing the others.
  const chain = resolvedBedrockModel ? [resolvedBedrockModel] : BEDROCK_MODEL_CHAIN;
  let lastErr;

  for (const model of chain) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const text = await bedrockOnce({ model, system, user, schema });
        resolvedBedrockModel = model;
        activeModelId = model;
        return JSON.parse(text);
      } catch (err) {
        lastErr = err;
        if (err instanceof BedrockModelAccessError) break; // try the next model
        const status = err.status;
        // 4xx other than 429 is a request problem — retrying changes nothing.
        if (status && status !== 429 && status < 500) throw err;
        await sleep(1500 * 2 ** attempt);
      }
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
