'use client';

import type { ReactNode } from 'react';
import { ChevronsDownUp, ChevronsUpDown, LayoutGrid, List } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';

export type ViewType = 'card' | 'list';

/**
 * the machines heading and its controls: the page's own buttons (`children`),
 * then expand or collapse all and the card / list toggle. /demo renders it too,
 * so the two cannot drift apart.
 */
export function MachinesHeading({
  children,
  allExpanded,
  onToggleAll,
  viewType,
  onViewChange,
}: {
  children?: ReactNode;
  allExpanded: boolean;
  onToggleAll: () => void;
  viewType: ViewType;
  onViewChange: (view: ViewType) => void;
}) {
  return (
    // `flex-wrap` lets the page's buttons and the segmented view toggle drop
    // under the heading at narrow widths instead of squeezing the row past the
    // viewport.
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg md:text-xl font-bold text-foreground">machines</h2>

      <div className="flex items-center gap-2">
        {children}

        <div className="flex items-center gap-1 rounded-lg bg-card-sunken p-1 select-none">
          <IconButton
            label={allExpanded ? 'collapse all' : 'expand all'}
            variant="ghost"
            size="sm"
            onClick={onToggleAll}
            className="cursor-pointer text-muted-foreground"
          >
            {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
          </IconButton>
          <div className="h-4 w-px bg-border" />
          <IconButton
            label="card view"
            aria-pressed={viewType === 'card'}
            variant="ghost"
            size="sm"
            onClick={() => onViewChange('card')}
            className={`cursor-pointer ${viewType === 'card' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="list view"
            aria-pressed={viewType === 'list'}
            variant="ghost"
            size="sm"
            onClick={() => onViewChange('list')}
            data-testid="view-toggle-list"
            className={`cursor-pointer ${viewType === 'list' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
          >
            <List className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
