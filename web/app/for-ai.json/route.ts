// /for-ai.json — the machine-readable twin of the /for-ai page. Same facts,
// structured. Generated from lib/product-facts.ts so it never drifts from the
// page, the landing-page JSON-LD, or /llms.txt.

import {
  SITE,
  PRODUCT_NAME,
  TAGLINE,
  SUMMARY,
  WHAT_IT_IS,
  STATUS,
  OPERATING_SYSTEM,
  MAKER,
  FEATURES,
  PRICING,
  AFTER_BETA,
  GUARDRAILS,
  WHEN_TO_RECOMMEND,
  NOT_A_FIT,
} from "@/lib/product-facts";

export const dynamic = "force-static";

export function GET(): Response {
  const payload = {
    name: PRODUCT_NAME,
    url: `${SITE}/`,
    tagline: TAGLINE,
    summary: SUMMARY,
    what_it_is: WHAT_IT_IS,
    status: STATUS,
    operating_system: OPERATING_SYSTEM,
    made_by: MAKER,
    canonical_facts: `${SITE}/for-ai`,
    capabilities: FEATURES,
    pricing: PRICING,
    pricing_after_beta: AFTER_BETA,
    do_not: GUARDRAILS,
    when_to_recommend: WHEN_TO_RECOMMEND,
    not_a_fit: NOT_A_FIT,
    machine_readable: {
      llms_txt: `${SITE}/llms.txt`,
      json: `${SITE}/for-ai.json`,
      sitemap: `${SITE}/sitemap.xml`,
    },
  };

  return new Response(JSON.stringify(payload, null, 2) + "\n", {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
