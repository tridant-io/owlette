import type { ReactNode } from 'react';

// highlight matches so filtered rows show why they matched
export function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lowerQ, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    // by day cyan glyphs on a cyan tint miss aa, so they go to ink, as the highlighter link does
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-accent-cyan/25 font-semibold text-foreground dark:text-accent-cyan">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}
