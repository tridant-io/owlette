'use client';

import { useState } from 'react';
import React from 'react';
import { Plus, Minus } from 'lucide-react';
import {
  AFTER_BETA,
  FREE_COVERS,
  INCLUDED_STORAGE,
  PRICING_FACTS,
  STORAGE_OVERAGE,
  perMachineMonth,
  usd,
} from '@/lib/product-facts';

const faqs: { q: string; a: React.ReactNode }[] = [
  {
    q: "is it actually free?",
    a: `during beta, yes — every tier, no credit card, no trial clock. ${AFTER_BETA} owlette free covers ${FREE_COVERS}. core is ${perMachineMonth(
      PRICING_FACTS.core.list,
    )} for monitoring, process control, displays, and alerts on a single site. pro is ${perMachineMonth(
      PRICING_FACTS.pro.list,
    )} (${
      PRICING_FACTS.pro.minMachines
    }-machine minimum) and adds deployment, hoot, talons, swoop, the public API, CLI, SDK, webhooks, unlimited sites, and roost — incremental project sync with ${INCLUDED_STORAGE} included storage per site. the first ${
      PRICING_FACTS.foundersCohort
    } customers keep a founders rate of ${usd(PRICING_FACTS.core.founders)} core / ${usd(
      PRICING_FACTS.pro.founders,
    )} pro, permanently. no per-user fees on any tier.`,
  },
  {
    q: "does it work on mac or linux?",
    a: "yes. the agent runs on windows, on macs with apple silicon (macos 15 or later) and on linux (ubuntu 24.04). one dashboard, every machine, including swoop on a mac.",
  },
  {
    q: "what happens if my machine loses internet?",
    a: "the agent keeps running. it monitors and auto-recovers processes whether or not it can reach the cloud. when the connection returns, it syncs everything it missed. your machines don't need the internet to run. they've been alone before. they know how to survive.",
  },
  {
    q: "do i need to open firewall ports or set up a vpn?",
    a: "no inbound ports, no vpn. agents connect outbound over https (port 443) to google's firebase infrastructure. if your network allows general internet access, it just works. locked-down environments may need to whitelist *.googleapis.com and *.firebaseio.com.",
  },
  {
    q: "what's hoot?",
    a: "hoot is owlette's ai fleet assistant — ask it the questions you ask yourself every day: \"which nvidia driver are we running?\", \"restart the media server on node 3\", \"what crashed at 3am?\" it translates natural language into real commands across your fleet. you bring your own api key (openai, anthropic, or any compatible provider).",
  },
  {
    q: "what's roost?",
    a: `roost is owlette's project sync. point it at a folder — a TouchDesigner project, a content drop, a build output — and it ships only the bytes that changed to every machine on the site, atomically: a machine gets the whole new version or stays on the old one, never a half-copied mess. every deploy is versioned, so you can roll back to any of the last 50 for up to 30 days. it's part of the pro tier and includes ${INCLUDED_STORAGE} of storage per site (${STORAGE_OVERAGE} after that). no more zipping a folder and RDP-ing into ten machines at 2am.`,
  },
  {
    q: "is my data secure?",
    a: "agents connect over tls, credentials are encrypted on-device using a machine-bound key, and oauth tokens are never logged or stored in plaintext. access is managed through firebase auth with optional passkey and two-factor authentication.",
  },
  {
    q: "can i self-host it?",
    a: "yes — owlette is FSL-1.1-Apache-2.0 (converts to apache 2.0 two years after each release). the full source is on github. fair warning: it requires firebase, a railway (or equivalent) deployment for the web app, and a willingness to blow past your usage limits at 3am debugging support tickets from your neighbor's camper because your furnace broke and it's -10 outside. we won't talk you out of it, but the hosted version exists for a reason.",
  },
];

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // Matches the grid-template-rows collapse transition (0.3s) + a small buffer.
  const COLLAPSE_MS = 320;

  const toggle = (i: number, el: HTMLElement | null) => {
    if (openIndex === i) {
      setOpenIndex(null);
      return;
    }
    // If an item above is open, let its panel finish collapsing before anchoring.
    // (block: 'start' honours the global scroll-padding-top, so it clears the header.)
    const delay = openIndex !== null && openIndex < i ? COLLAPSE_MS : 0;
    setOpenIndex(i);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), delay);
  };

  return (
    <section id="faq" className="pt-16 sm:pt-24 pb-32 sm:pb-48 px-4 sm:px-6 -scroll-mt-8 sm:-scroll-mt-16">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10 sm:mb-14">
          <h2 className="section-headline text-foreground mb-4">
            questions, answered.
          </h2>
        </div>

        <div className={`border-t transition-colors duration-300 ${openIndex === 0 ? 'border-transparent' : 'border-border'}`}>
          {faqs.map((faq, i) => {
            const isOpen = openIndex === i;
            return (
              <React.Fragment key={i}>
              {/* a white wash vanishes on paper, so day hovers with the shared
                  surface tint and night keeps its faint white */}
              <div
                className={`group px-6 transition-all duration-300 ${
                  isOpen ? 'bg-card/60 rounded-2xl border border-border' : 'hover:bg-[var(--surface-hover)] dark:hover:bg-elevation-ring/40'
                }`}
              >
                <button
                  onClick={(e) => toggle(i, e.currentTarget)}
                  className="w-full flex items-center justify-between gap-4 py-7 text-left cursor-pointer"
                  aria-expanded={isOpen}
                >
                  <span className={`text-base sm:text-lg font-medium transition-colors duration-300 ${isOpen ? 'text-accent-cyan' : 'text-foreground/80 group-hover:text-foreground'}`}>
                    {faq.q}
                  </span>
                  {isOpen
                    ? <Minus className="w-4 h-4 text-accent-cyan shrink-0" />
                    : <Plus className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
                  }
                </button>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateRows: isOpen ? '1fr' : '0fr',
                    transition: 'grid-template-rows 0.3s ease',
                  }}
                >
                  <div className="overflow-hidden">
                    <p className="pb-8 text-base sm:text-lg text-muted-foreground leading-loose">
                      {faq.a}
                    </p>
                  </div>
                </div>
              </div>
              {i < faqs.length - 1 && (
                <div className={`border-b transition-colors duration-300 ${isOpen || openIndex === i + 1 ? 'border-transparent' : 'border-border'}`} />
              )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
