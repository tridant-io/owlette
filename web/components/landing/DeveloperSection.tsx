'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, KeyRound, RefreshCw, Webhook } from 'lucide-react';
import { CLI_DIR_URL } from '@/lib/repoLinks';

type TabId = 'curl' | 'cli' | 'typescript';

const TABS: { id: TabId; label: string }[] = [
  { id: 'curl', label: 'curl' },
  { id: 'cli', label: 'cli' },
  { id: 'typescript', label: 'typescript' },
];

const SAMPLES: Record<TabId, string> = {
  curl: `# restart a process across the API
URL="https://owlette.app/api/sites/$SITE/machines/$MACHINE"

curl -X POST "$URL/processes/$PROC/restart" \\
  -H "Authorization: Bearer $OWLETTE_TOKEN" \\
  -H "Idempotency-Key: $(uuidgen)"`,
  cli: `# install once
npm i -g @owlette/cli
owlette login

# restart a process anywhere
owlette process restart $PROC \\
  --site $SITE --machine $MACHINE`,
  typescript: `import { Owlette } from '@owlette/sdk';

const owlette = new Owlette({
  token: process.env.OWLETTE_TOKEN!,
});

await owlette
  .processes(siteId, machineId)
  .restart(processId);`,
};

const PROOF_CHIPS: { icon: typeof KeyRound; label: string; body: string }[] = [
  {
    icon: KeyRound,
    label: 'scoped keys',
    body: 'keys are scoped per-site and per-action. a webhook delivery key cannot restart a machine.',
  },
  {
    icon: RefreshCw,
    label: 'idempotency-key required on writes',
    body: 'every mutating endpoint enforces idempotency. retry without doubling up.',
  },
  {
    icon: Webhook,
    label: 'webhooks with HMAC signatures',
    body: 'subscribe to process / deploy / display events. signed payloads, verifiable in any language.',
  },
];

export function DeveloperSection() {
  const [activeTab, setActiveTab] = useState<TabId>('curl');

  return (
    <section id="developers" className="py-16 sm:py-24 px-4 sm:px-6 relative -scroll-mt-8 sm:-scroll-mt-16">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12 sm:mb-16">
          <h2 className="section-headline text-foreground mb-4 leading-tight">
            every dashboard action, scriptable.
          </h2>
          <p className="section-subheadline text-balance max-w-3xl mx-auto">
            restart a process, push a deploy, or check machine health from
            wherever your automation already runs — install the CLI on a
            runner, import the SDK into your backend, or just curl it.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 lg:items-stretch">
          {/* Code block — 60% on desktop, full on mobile */}
          <div className="lg:w-3/5 flex">
            <div className="flex-1 min-w-0 rounded-xl border border-border bg-card/60 shadow-2xl shadow-elevation-shadow/60 ring-1 ring-elevation-ring/50 overflow-hidden flex flex-col">
              <div role="tablist" className="flex border-b border-border bg-card/40">
                {TABS.map((tab) => {
                  const isActive = tab.id === activeTab;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-4 py-2.5 text-sm font-mono transition-colors cursor-pointer border-b-2 -mb-px ${
                        isActive
                          ? 'text-accent-cyan border-accent-cyan'
                          : 'text-muted-foreground border-transparent hover:text-foreground'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <pre className="flex-1 p-4 sm:p-5 text-xs sm:text-sm font-mono text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
                <code>{SAMPLES[activeTab]}</code>
              </pre>
            </div>
          </div>

          {/* Proof chips — 40% on desktop, stacked below on mobile */}
          <div className="lg:w-2/5 flex flex-col gap-3">
            {PROOF_CHIPS.map((chip) => (
              <div
                key={chip.label}
                className="rounded-xl border border-border bg-card/60 p-4 shadow-2xl shadow-elevation-shadow/60 ring-1 ring-elevation-ring/50"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <chip.icon className="w-4 h-4 text-accent-cyan flex-shrink-0" />
                  <h3 className="text-sm font-semibold text-foreground">
                    {chip.label}
                  </h3>
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                  {chip.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-10 mt-12 sm:mt-16">
          <Link
            href="/docs/api"
            className="inline-flex items-center gap-1.5 text-base text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
          >
            read the api reference
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
          <Link
            href={CLI_DIR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-base text-muted-foreground hover:text-foreground transition-colors group"
          >
            install the cli
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </div>
    </section>
  );
}
