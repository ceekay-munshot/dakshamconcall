/**
 * llm.mjs — thin clients for the analysis engine.
 * =================================================
 *   - openaiStructured(): OpenAI Chat Completions with Structured Outputs
 *     (response_format json_schema, strict), ONE pinned model, temperature 0.
 *     Same input -> same structure, every quarter. The model ORGANIZES the
 *     provided summary into our schema; it does not opine.
 *   - firecrawlScrape(): fallback fetch for pages/PDFs that block direct access
 *     (exchange PDFs hotlink-block). Returns extracted text (markdown).
 *
 * Node 22 (global fetch). All secrets come from env — nothing is hardcoded.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

/** The single pinned model. Swappable via env, defaults to gpt-4o-mini. */
export const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** Small sleep for retry backoff. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call OpenAI with a strict JSON schema and return the parsed object.
 * temperature: 0 for determinism. Retries transient (429/5xx) errors.
 *
 * @param {object}   opts
 * @param {string}   opts.system      System prompt (the "organize, don't opine" rules).
 * @param {string}   opts.user        User content (the summary + context to organize).
 * @param {string}   opts.schemaName  Name for the json_schema.
 * @param {object}   opts.schema      A strict JSON schema (additionalProperties:false, all keys required).
 * @returns {Promise<object>} the validated, parsed object.
 */
export async function openaiStructured({ system, user, schemaName, schema }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const body = {
    model: MODEL,
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
