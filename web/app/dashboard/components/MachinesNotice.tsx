/**
 * What the dashboard shows in place of the getting-started card when it has no
 * machines to list: the machines listener was refused, or a scoped member's
 * machine scope holds nothing they can see yet.
 */

import { Monitor } from 'lucide-react';
import { Card } from '@/components/ui/card';

export function machinesNotice(input: {
  scoped: boolean;
  loading: boolean;
  count: number;
  error: string | null;
}): 'load_error' | 'none_for_you' | null {
  if (input.error) return 'load_error';
  if (input.scoped && !input.loading && input.count === 0) return 'none_for_you';
  return null;
}

export function NoMachinesForYou() {
  return (
    // gap-0: card's own gap-6 pulls the icon, title and line apart
    <Card className="border-border bg-card items-center gap-0 px-6 py-12 text-center animate-in fade-in duration-300">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted" aria-hidden="true">
        <Monitor className="size-7 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold text-foreground text-balance">no machines here for you yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
        a site admin chooses which machines you can reach.
      </p>
    </Card>
  );
}

export function MachinesLoadError({ error }: { error: string }) {
  // firestore's messages end in a full stop, and the copy adds its own
  const reason = error.replace(/\.+$/, '');
  return (
    <div className="bg-danger-surface border border-danger-border rounded-lg p-4 text-danger">
      machines couldn&apos;t load: {reason}. reload, or ask a site admin if it keeps happening.
    </div>
  );
}
