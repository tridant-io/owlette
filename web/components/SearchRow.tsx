'use client';

/**
 * the one search field the menus and hoot draw, so the four places agree and
 * cannot drift apart. the owner's rule (2026-11-05): a search inside a menu or
 * popover is a `row`, edge to edge with a rule under it; on a page or in a
 * header row it is a quiet `field`, enclosed and rounded, whose focus only
 * tints its border rather than lighting it up.
 */

import { useImperativeHandle, useRef, type ComponentProps } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const VARIANT = {
  row: 'flex items-center gap-2 border-b border-border px-3 py-2',
  field: 'flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 focus-within:border-ring',
} as const;

type SearchRowProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'className' | 'autoComplete'> & {
  value: string;
  onChange: (value: string) => void;
  variant?: keyof typeof VARIANT;
  /** `with-text` shows the x only while there is text; `always` keeps it, for a search the x also closes */
  clear?: 'with-text' | 'always';
  clearLabel?: string;
  /** called after the x clears the text and focuses the input again */
  onClear?: () => void;
  /** on the wrapper, merged, so a caller's padding wins over the variant's */
  className?: string;
};

export function SearchRow({
  value,
  onChange,
  variant = 'row',
  clear = 'with-text',
  clearLabel = 'clear filter',
  onClear,
  className,
  type = 'text',
  ref,
  ...props
}: SearchRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!, []);

  return (
    <div className={cn(VARIANT[variant], className)}>
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        {...props}
        ref={inputRef}
        type={type}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 16px below md: ios zooms the page into any field smaller than that
        className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
      />
      {(clear === 'always' || value !== '') && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
            onClear?.();
          }}
          // in a radix menu a key that got past this button would be typeahead
          onKeyDown={(e) => {
            if (e.key !== 'Tab') e.stopPropagation();
          }}
          aria-label={clearLabel}
          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
