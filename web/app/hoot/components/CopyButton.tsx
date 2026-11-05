'use client';

import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface CopyButtonProps {
  value: string;
  className?: string;
  iconSize?: 'xs' | 'sm';
  /**
   * Accessible name and tooltip. Several copy buttons in one list need names
   * that tell them apart — to a screen reader and to a role query alike. Named
   * as in `components/CopyButton.tsx`, which carries the same prop.
   */
  tooltipLabel?: string;
}

export function CopyButton({
  value,
  className = '',
  iconSize = 'xs',
  tooltipLabel = 'copy to clipboard',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  };

  const size = iconSize === 'sm' ? 'h-3.5 w-3.5' : 'h-3 w-3';

  // The app's own tooltip, not the browser's `title` bubble: this button sits
  // beside the edit pencil in the hoot message toolbar, and two controls an inch
  // apart cannot answer in two different styles.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleCopy}
          className={`inline-flex items-center gap-1 p-0 bg-transparent border-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer ${className}`}
          aria-label={tooltipLabel}
          type="button"
        >
          {copied ? (
            <Check className={`${size} text-success`} />
          ) : (
            <Copy className={size} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{copied ? 'copied' : tooltipLabel}</p>
      </TooltipContent>
    </Tooltip>
  );
}
