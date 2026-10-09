/**
 * Guard for the invariant that let a stale price ship once already: commit
 * 0d7ce7fa raised core/pro from $10/$50 to $20/$60 in `PRICING` but left the
 * schema.org offers and the assistant guardrails at the old numbers. Both are
 * invisible to a human reading the pricing page — the drift only surfaced in
 * Google rich results and in llms.txt, where the two figures sat three lines
 * apart contradicting each other.
 *
 * The invariant: no dollar figure may appear on ANY public surface unless it is
 * derivable from `PRICING_FACTS`. That catches drift in both directions — a
 * number raised in one place and not the others, and a number left behind.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  AFTER_BETA,
  FREE_SCOPE,
  GUARDRAILS,
  PRICE_LINE,
  PRICING,
  PRICING_FACTS,
  PRODUCT_JSONLD,
  perMachineMonth,
  usd,
} from '@/lib/product-facts';

/** Every amount PRICING_FACTS legitimately authorises, as rendered strings. */
const ALLOWED = new Set(
  [
    PRICING_FACTS.core.list,
    PRICING_FACTS.core.founders,
    PRICING_FACTS.pro.list,
    PRICING_FACTS.pro.founders,
    PRICING_FACTS.storage.overagePerGB,
  ].map(usd),
);

/** Matches `$20`, `$0.05` — the two shapes `usd()` emits. */
const MONEY = /\$\d+(?:\.\d+)?/g;

function amountsIn(text: string): string[] {
  return text.match(MONEY) ?? [];
}

describe('pricing is single-sourced from PRICING_FACTS', () => {
  it('exposes no dollar figure outside PRICING_FACTS on the runtime surfaces', () => {
    // Exactly what /for-ai.json, /llms.txt, /for-ai and the landing JSON-LD serve.
    const serialized = JSON.stringify({
      PRICING,
      GUARDRAILS,
      PRODUCT_JSONLD,
      AFTER_BETA,
      PRICE_LINE,
    });
    const stray = amountsIn(serialized).filter((a) => !ALLOWED.has(a));
    expect(stray).toEqual([]);
  });

  it('quotes the current core and pro prices, not a stale pair', () => {
    const serialized = JSON.stringify({ PRICING, GUARDRAILS, PRODUCT_JSONLD });
    expect(serialized).toContain(perMachineMonth(PRICING_FACTS.core.list));
    expect(serialized).toContain(perMachineMonth(PRICING_FACTS.pro.list));
  });

  it('states the same core price in the guardrails as in the tier list', () => {
    // The exact failure of 0d7ce7fa: PRICING said $20, GUARDRAILS said $10.
    const core = PRICING.find((t) => t.name === 'core');
    expect(core).toBeDefined();
    const guardrailAmounts = amountsIn(GUARDRAILS.join(' '));
    expect(guardrailAmounts).toContain(usd(PRICING_FACTS.core.list));
    expect(guardrailAmounts).not.toContain(usd(PRICING_FACTS.pro.founders));
  });

  it('states the same prices in the schema.org offers as in the tier list', () => {
    // JSON-LD is machine-only, so nothing but this test reads it.
    const offers = JSON.stringify(PRODUCT_JSONLD.offers);
    expect(offers).toContain(perMachineMonth(PRICING_FACTS.core.list));
    expect(offers).toContain(perMachineMonth(PRICING_FACTS.pro.list));
    const stray = amountsIn(offers).filter((a) => !ALLOWED.has(a));
    expect(stray).toEqual([]);
  });

  it('lists owlette free with the limits from PRICING_FACTS', () => {
    const free = PRICING.find((t) => t.name === 'owlette free');
    expect(free).toBeDefined();
    expect(free?.detail).toContain(FREE_SCOPE);
    expect(FREE_SCOPE).toContain(`${PRICING_FACTS.free.machines} machine`);
    expect(FREE_SCOPE).toContain(`${PRICING_FACTS.free.sites} site`);
    expect(PRICE_LINE).toContain(`free for ${PRICING_FACTS.free.machines} machine`);
  });

  it('offers every tier in the schema.org offers, owlette free at price 0', () => {
    // a tier added to PRICING but not to the offers drifts the same silent way.
    const { offers, offerCount } = PRODUCT_JSONLD.offers;
    expect(offers.map((o) => o.name)).toEqual(PRICING.map((t) => t.name));
    expect(offerCount).toBe(String(PRICING.length));
    const free = offers.find((o) => o.name === 'owlette free');
    expect(free?.price).toBe('0');
    expect(free?.description).toContain(FREE_SCOPE);
  });

  it('states the trial and the active-machine rule from PRICING_FACTS', () => {
    expect(AFTER_BETA).toContain(`${PRICING_FACTS.trialDays}-day pro trial`);
    expect(AFTER_BETA).toContain(PRICING_FACTS.billingUnit);
    expect(AFTER_BETA).toContain(PRICING_FACTS.activeMachine);
    // assistants read the guardrails, not the landing page.
    expect(GUARDRAILS.join(' ')).toContain(AFTER_BETA);
  });

  it('hardcodes no price in the landing components', () => {
    // Composition, not retyping: a literal `'$20'` here is how drift restarts.
    const dir = path.join(process.cwd(), 'components', 'landing');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.tsx')) continue;
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        // A money figure inside a quoted string literal, not a `${...}` slot.
        if (/(['"])[^'"]*\$\d/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
