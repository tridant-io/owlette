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
    <Card className="border-border bg-card/50 p-6 text-center">
      <Monitor className="mx-auto h-6 w-6 text-muted-foreground" />
      <p className="mt-2 text-sm text-foreground">no machines here for you yet</p>
      <p className="mt-1 text-xs text-muted-foreground">
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
