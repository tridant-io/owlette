import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Panel({
  id,
  title,
  description,
  actions,
  tone = 'default',
  className,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'rounded-xl border bg-card p-4 sm:p-5',
        tone === 'danger' ? 'border-danger-border' : 'border-border',
        className,
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className={cn('text-sm font-semibold', tone === 'danger' ? 'text-danger' : 'text-foreground')}>
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
