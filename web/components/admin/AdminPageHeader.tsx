import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The header every admin page shares, so no page can push a control off a phone.
 *
 * From md up it is the row the pages always had: title and description on the
 * left, the toolbar then the actions on the right. Below md it regrids: the
 * actions share the title's row, the description takes a full line, and the
 * toolbar wraps on a row of its own. `display: contents` lets the same elements
 * sit in either layout.
 */
export function AdminPageHeader({
  title,
  description,
  actions,
  toolbar,
  className,
  controlsClassName,
}: {
  title: string;
  description: ReactNode;
  /** the primary actions: they sit beside the title on a phone, so keep them compact */
  actions?: ReactNode;
  /** site picker, secondary actions and tallies: a wrapping row of their own on a phone */
  toolbar?: ReactNode;
  className?: string;
  /** md and up: the right-hand group that holds the toolbar and the actions */
  controlsClassName?: string;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center max-md:gap-x-3 max-md:gap-y-2 md:flex md:justify-between',
        className,
      )}
    >
      <div className="contents md:block">
        <h1 className="col-start-1 row-start-1 text-2xl font-bold text-foreground md:mb-2 md:text-3xl">{title}</h1>
        <p className="col-span-full row-start-2 text-muted-foreground max-md:text-sm">{description}</p>
      </div>
      {(toolbar || actions) && (
        <div className={cn('contents md:flex md:items-center md:gap-3', controlsClassName)}>
          {toolbar && (
            <div className="col-span-full row-start-3 flex flex-wrap items-center gap-2 md:contents">{toolbar}</div>
          )}
          {actions && <div className="col-start-2 row-start-1 flex items-center gap-2 md:contents">{actions}</div>}
        </div>
      )}
    </div>
  );
}
