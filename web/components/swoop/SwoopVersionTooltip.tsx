'use client';

/**
 * owlette swoop's mark, naming the installed release on hover: the version
 * comes off the app's ua token, so a browser has none and the mark stays a
 * mark. the child is the trigger, so it must be a dom element.
 */

import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerAppVersion } from '@/hooks/useViewerAppPlatform';

export function SwoopVersionTooltip({ children }: { children: ReactElement }) {
  const version = useViewerAppVersion();
  if (!version) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        owlette swoop v{version}
      </TooltipContent>
    </Tooltip>
  );
}
