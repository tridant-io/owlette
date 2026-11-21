import type { ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A button that shows its icon and label from sm up, and the icon alone below it,
 * so it fits beside a title or at the end of a table row on a phone. The label
 * stays its accessible name at every width.
 */
export function CompactButton({
  icon: Icon,
  label,
  iconClassName = 'sm:mr-2',
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'aria-label'> & {
  icon: LucideIcon;
  label: string;
  /** spacing after the icon from sm up; the header buttons have always carried mr-2 */
  iconClassName?: string;
}) {
  return (
    <Button aria-label={label} className={cn('max-sm:aspect-square max-sm:has-[>svg]:px-0', className)} {...props}>
      <Icon className={cn('h-4 w-4', iconClassName)} />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
