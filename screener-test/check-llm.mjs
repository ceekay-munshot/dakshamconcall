/**
 * check-llm.mjs — a 5-second, few-paise sanity check on the LLM key.
 * ===================================================================
 * Makes ONE tiny structured call through the same seam the pipeline uses, so
 * whatever this prints is exactly what the real run will do. Run it before a
 * full analyze run whenever a key or provider changes — it costs almost
 * nothing and turns "the run failed after 20 minutes" into "the key is wrong".
 *
 *   node screener-test/check-llm.mjs
 */

import { llmStructured, llmBanner, activeModel, PROVIDER } from "./llm.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["company", "revenue_cr"],
  properties: {
    company: { type: "string" },
    revenue_cr: { type: "string" },
  },
};

async function main() {
  console.log(llmBanner());
  console.log(
    `keys present: BEDROCK_API_KEY=${process.env.BEDROCK_API_KEY ? "yes" : "no"} ` +
      `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "yes" : "no"} (preferred: ${PROVIDER})`
  );

  const t0 = Date.now();
  const out = await llmStructured({
    system: "Extract the figures exactly as stated. Do not add or infer anything.",
    user: "Acme Ltd reported revenue of Rs 1,234 crore in Q1 FY26.",
    schemaName: "llm_healthcheck",
    schema: SCHEMA,
  });
  const ms = Date.now() - t0;

  console.log(`served by: ${activeModel()} in ${ms} ms`);
  console.log("parsed output:", JSON.stringify(out));

  const ok = /acme/i.test(out.company || "") && /1,?234/.test(out.revenue_cr || "");
  if (!ok) {
    console.error("FAIL — the model answered but the values look wrong. Output above.");
    process.exit(1);
  }
  console.log("OK — structured output works end to end.");
}

main().catch((err) => {
  console.error(`FAIL — ${err.message || err}`);
  process.exit(1);
});
