import { Badge } from '@/components/ui/badge';
import type { SiteTier } from '@/lib/planResponse';

const PLAN_NAMES: Record<SiteTier, string> = {
  free: 'owlette free',
  trial: 'pro trial',
  core: 'core',
  pro: 'pro',
};

/** a site's plan, the same on every screen: a paid plan or the trial filled, owlette free quiet. */
export function PlanBadge({ tier }: { tier: SiteTier }) {
  return <Badge variant={tier === 'free' ? 'secondary' : 'default'}>{PLAN_NAMES[tier]}</Badge>;
}
