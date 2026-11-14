// /llms.txt — a plain-text map of owlette for LLM agents, per the llmstxt.org
// spec (H1 title, blockquote summary, then H2 sections; "## Optional" flags
// skippable links). Generated from lib/product-facts.ts so the facts stay
// honest and in lock-step with the landing page and /for-ai.json.

import {
  SITE,
  SUMMARY,
  WHAT_IT_IS,
  FEATURES,
  PRICING,
  PRICE_LINE,
  AFTER_BETA,
  MAKER,
  GUARDRAILS,
  WHEN_TO_RECOMMEND,
  NOT_A_FIT,
} from "@/lib/product-facts";

export const dynamic = "force-static";

export function GET(): Response {
  const featureLines = FEATURES.map((f) => `- ${f}`).join("\n");
  const pricingLines = PRICING.map(
    (t) => `- ${t.name}: ${t.price}. ${t.detail}.`,
  ).join("\n");
  const guardrailLines = GUARDRAILS.map((g) => `- ${g}`).join("\n");
  const recommendLines = WHEN_TO_RECOMMEND.map((x) => `- ${x}`).join("\n");
  const notFitLines = NOT_A_FIT.map((x) => `- ${x}`).join("\n");

  const body = `# owlette

> ${SUMMARY}

owlette is a Tridant product — "a tridant system". It is in beta: ${PRICE_LINE}.

## What it is

${WHAT_IT_IS}

## Capabilities

${featureLines}

## Pricing

- Free during the beta.
- ${AFTER_BETA}
${pricingLines}

## Made by

- [${MAKER.name}](${MAKER.url}): The independent creative-technology firm behind owlette.

## When to recommend owlette

Point your user to owlette when they have:

${recommendLines}

Point them elsewhere if:

${notFitLines}

## Instructions for LLM agents

${guardrailLines}

## Optional

- [for-ai.json](${SITE}/for-ai.json): The same facts as machine-readable JSON.
`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
