'use client';

import type { ReactNode } from 'react';
import { Cog, Monitor } from 'lucide-react';
import type { Machine } from '@/hooks/useFirestore';

/**
 * the dashboard's first row: the greeting, and beside it how many machines are
 * online and how many processes they run. /demo renders it too, so the two
 * cannot drift apart.
 */
export function DashboardWelcome({
  greeting,
  subtitle,
  machines,
}: {
  greeting: ReactNode;
  subtitle: string;
  machines: readonly Machine[];
}) {
  const onlineMachines = machines.filter((m) => m.online).length;
  const totalProcesses = machines.reduce(
    (acc, m) => acc + (m.metrics?.processes ? Object.keys(m.metrics.processes).length : 0),
    0,
  );

  return (
    <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
      <div className="flex-1 min-w-0">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1 truncate">
          {greeting}
        </h1>
        <p className="text-sm md:text-base text-muted-foreground">
          {subtitle}
        </p>
      </div>

      {/* Quick stats - inline with welcome. Wraps at narrow widths so the
          two stat blocks + divider can never push the page wider than the
          viewport. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6 md:gap-8">
        {/* Machines / Online ratio */}
        <div className="flex items-center gap-2.5">
          <div className={`rounded-md p-1.5 ${onlineMachines > 0 ? 'bg-success-surface text-success' : 'bg-muted text-muted-foreground'}`}>
            <Monitor className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-baseline gap-0.5 tabular-nums">
              <span className={`text-xl font-bold ${onlineMachines > 0 ? 'text-success' : 'text-foreground'}`}>{onlineMachines}</span>
              <span className="text-xs text-muted-foreground">/ {machines.length}</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">online</p>
          </div>
        </div>

        {/* Divider */}
        <div className="h-8 w-px bg-border" />

        {/* Processes */}
        <div className="flex items-center gap-2.5">
          <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
            <Cog className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-baseline gap-0.5 tabular-nums">
              <span className="text-xl font-bold text-foreground">{totalProcesses}</span>
              <span className="text-xs text-muted-foreground">managed</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">processes</p>
          </div>
        </div>
      </div>
    </div>
  );
}
