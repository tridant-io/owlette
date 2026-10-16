import { MonitorPlay } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * the "owlette swoop" lockup, one rule at every size: the monitor's body sits
 * on the text's baseline and its stand hangs into the descender zone, like the
 * p in swoop. lucide's monitor-play puts the body's base at 17/24 of its box,
 * so the icon is lowered by the stand's 7/24 through `vertical-align`, which
 * needs inline flow (a flex row would centre it on the line box and sit it
 * high). no rule between the words: the icon is the separator.
 */
export function SwoopLockup({ size = 'sm', className }: { size?: 'sm' | 'lg'; className?: string }) {
  const px = size === 'lg' ? 20 : 14;
  return (
    <span data-testid="swoop-lockup" className={cn('inline whitespace-nowrap', className)}>
      <span className={cn('font-semibold text-foreground', size === 'sm' && 'text-base')}>owlette</span>{' '}
      <MonitorPlay
        aria-hidden
        className={cn('inline-block shrink-0 text-muted-foreground', size === 'lg' ? 'ml-1 mr-1.5' : 'ml-0.5 mr-1')}
        style={{ width: px, height: px, verticalAlign: -(px * 7) / 24 }}
      />
      <span className={cn('font-medium text-foreground', size === 'sm' && 'text-sm')}>swoop</span>
    </span>
  );
}
