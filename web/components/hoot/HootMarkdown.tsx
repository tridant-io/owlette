/**
 * one markdown message part, as hoot draws it — the live chat and a share
 * snapshot render through this, so both scroll a wide table and wrap a long
 * token the same way.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// a gfm table is as wide as its widest row: it scrolls inside the message
// rather than pushing the chat column off a phone screen.
const COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  ),
};

export function HootMarkdown({ text }: { text: string }) {
  return (
    <div className="hoot-markdown text-sm text-foreground prose dark:prose-invert prose-sm max-w-none break-words prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
