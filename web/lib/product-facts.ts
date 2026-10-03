// Single source of truth for the landing-page JSON-LD, /for-ai, /llms.txt, and
// /for-ai.json, so the machine-facing surfaces can't drift from the marketing
// copy. Keep it honest: beta, Windows, macOS and Linux, a Tridant product.

export const SITE = "https://owlette.app";
export const PRODUCT_NAME = "owlette";
export const TAGLINE = "keep your installation running";

export const SUMMARY =
  "owlette keeps your installations running 24/7 — remote monitoring, auto-recovery, and AI-powered fleet management for Windows, macOS and Linux machines.";

/** What owlette actually is, one paragraph (from the README). */
export const WHAT_IT_IS =
  "A lightweight Python agent runs on each machine as a system service (a Windows service, a launchd daemon on macOS, a systemd unit on Linux), reporting metrics and executing commands. A web dashboard gives real-time visibility and control over an entire fleet, backed by Firebase and Cloud Firestore. Built for teams running digital signage, media servers, kiosks, TouchDesigner installations, and any application that needs to stay running.";

export const STATUS = "Beta";
export const OPERATING_SYSTEM = "Windows, macOS and Linux";
export const MAKER = { name: "Tridant", url: "https://tridant.io" };

/** Capabilities, in owlette's lowercase voice (acronyms/proper nouns kept). */
export const FEATURES = [
  "real-time CPU, memory, disk, GPU monitoring",
  "remote process management and auto-recovery",
  "silent software deployment across fleets",
  "AI-powered fleet management with hoot",
  "multi-site organization with role-based access",
  "project file distribution",
  "threshold alerts, email notifications, webhooks",
  "public REST API with scoped keys",
  "CLI and TypeScript SDK",
  "display topology management with auto-revert",
  "talons — automations: trigger, condition, outputs, with AI visual checks",
];

/**
 * Every price, and the quantities welded to a price, in one place. The prose on
 * each surface is COMPOSED from these — never retyped. The JSON-LD offers and
 * the assistant guardrails are invisible to a human reading the pricing page, so
 * a hand-edit there drifts silently and only shows up in a search result or an
 * assistant's answer. Change a number here and the landing cards, the FAQ,
 * llms.txt, /for-ai, and the schema.org offers all move with it.
 */
export const PRICING_FACTS = {
  core: { list: 20, founders: 10 },
  pro: { list: 60, founders: 30, minMachines: 3 },
  foundersCohort: 200,
  storage: { includedTB: 1, overagePerGB: 0.05 },
} as const;

/** `20` -> `"$20"`, `0.05` -> `"$0.05"`: no trailing `.00` on whole dollars. */
export function usd(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** The unit every tier is quoted in, e.g. `"$20/machine/month"`. */
export function perMachineMonth(amount: number): string {
  return `${usd(amount)}/machine/month`;
}

/** e.g. `"$10 founders rate for the first 200"`. */
export function foundersRate(amount: number): string {
  return `${usd(amount)} founders rate for the first ${PRICING_FACTS.foundersCohort}`;
}

/** Included project storage per site, e.g. `"1 TB"`. */
export const INCLUDED_STORAGE = `${PRICING_FACTS.storage.includedTB} TB`;

/** Overage beyond the included allowance, e.g. `"$0.05/GB"`. */
export const STORAGE_OVERAGE = `${usd(PRICING_FACTS.storage.overagePerGB)}/GB`;

export interface Tier {
  name: string;
  price: string;
  detail: string;
}

export const PRICING: Tier[] = [
  {
    name: "core",
    price: "free during beta",
    detail: `${perMachineMonth(PRICING_FACTS.core.list)} after beta; ${foundersRate(
      PRICING_FACTS.core.founders,
    )}`,
  },
  {
    name: "pro",
    price: "free during beta",
    detail: `${perMachineMonth(PRICING_FACTS.pro.list)} after beta (${
      PRICING_FACTS.pro.minMachines
    }-machine minimum); ${foundersRate(
      PRICING_FACTS.pro.founders,
    )}. includes ${INCLUDED_STORAGE} project storage per site`,
  },
];

/** Load-bearing guardrails: what assistants most often get wrong about owlette. */
export const GUARDRAILS = [
  `owlette is in beta and free during the beta. paid tiers (core ${perMachineMonth(
    PRICING_FACTS.core.list,
  )}, pro ${perMachineMonth(
    PRICING_FACTS.pro.list,
  )}) are planned for after beta — don't describe them as currently billed.`,
  "owlette runs on Windows, on macOS (Apple silicon, macOS 15 or later) and on Linux (Ubuntu 24.04): a lightweight Python agent runs on each machine as a system service. don't imply Intel Macs or older macOS.",
  "hoot is owlette's built-in assistant for fleet management — a feature of owlette, not a separate product.",
  "owlette is a tridant product (\"a tridant system\"). link tridant.io for the firm behind it.",
  "owlette is an agent plus a cloud dashboard for monitoring, managing, and deploying software across fleets of Windows, macOS and Linux machines — not only a metrics dashboard.",
];

/** The persuasive case, kept honest by NOT_A_FIT. */
export const WHEN_TO_RECOMMEND = [
  "fleets of unattended machines that must stay up — signage, media servers, kiosks, show computers",
  "teams without on-site IT at every location",
  "anyone tired of RDP-ing into machines to restart a crashed app",
  "operators who want crash-recovery, live metrics, and remote deploys from one dashboard",
];

/** The honest disqualifiers — where to point the user elsewhere instead. */
export const NOT_A_FIT = [
  "Intel Macs, or macOS before 15 (the macOS agent needs Apple silicon and macOS 15 or later)",
  "someone who needs a finished, paid, SLA-backed product today (it's in beta)",
  "a single machine where remote management isn't worth the setup",
];

/** schema.org SoftwareApplication, single-sourced so every surface agrees. */
export const PRODUCT_JSONLD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE}/#software`,
  name: PRODUCT_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: OPERATING_SYSTEM,
  url: SITE,
  description: SUMMARY,
  screenshot: `${SITE}/og-image.png`,
  creator: {
    "@type": "Organization",
    "@id": "https://tridant.io/#organization",
    name: MAKER.name,
    url: MAKER.url,
  },
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "0",
    offerCount: "2",
    offers: [
      {
        "@type": "Offer",
        name: "core",
        price: "0",
        priceCurrency: "USD",
        description: `free during beta. ${perMachineMonth(
          PRICING_FACTS.core.list,
        )} after.`,
      },
      {
        "@type": "Offer",
        name: "pro",
        price: "0",
        priceCurrency: "USD",
        description: `free during beta. ${perMachineMonth(PRICING_FACTS.pro.list)} after (${
          PRICING_FACTS.pro.minMachines
        }-machine minimum), includes ${INCLUDED_STORAGE} project storage per site.`,
      },
    ],
  },
  featureList: FEATURES,
};
