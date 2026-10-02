'use client';

/**
 * Read-only rendering of a share snapshot's messages.
 *
 * The share dialog's preview and the public `/share/{token}` page both render
 * THIS component, so what the owner previews is exactly what a reader sees.
 * No auth context, no hooks that need a session: it must work on a page with
 * no signed-in user. Layout mirrors ChatWindow's turns (avatar + rail columns,
 * label row, markdown classes, user turns right-aligned) minus everything
 * interactive.
 */

import { Ban, CircleCheck, CircleDashed, CircleX, User, Wrench } from 'lucide-react';
import { HootIcon } from '@/components/icons/HootIcon';
import { HootMarkdown } from '@/components/hoot/HootMarkdown';
import type { SharedMessage, SharedToolOutcome } from '@/lib/hoot/shareTypes';

const OUTCOME: Record<SharedToolOutcome, { label: string; icon: typeof CircleCheck; className: string }> = {
  completed: { label: 'completed', icon: CircleCheck, className: 'text-emerald-400' },
  failed: { label: 'failed', icon: CircleX, className: 'text-red-400' },
  denied: { label: 'denied', icon: Ban, className: 'text-muted-foreground' },
  incomplete: { label: 'not completed', icon: CircleDashed, className: 'text-muted-foreground' },
};

/**
 * The avatar + rail column that frames a turn, as ChatWindow draws it. A user
 * turn gets a generic glyph, not `UserAvatar`: the snapshot is text-only and
 * carries no author identity, and the signed-in viewer's avatar would put the
 * reader's face beside someone else's words.
 */
function TurnAvatar({ role }: { role: SharedMessage['role'] }) {
  if (role === 'user') {
    return (
      <div className="flex-shrink-0 flex flex-col items-center">
        <div
          data-testid="shared-user-avatar"
          className="h-7 w-7 rounded-full bg-accent flex items-center justify-center"
        >
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-1 flex-1 w-0.5 bg-muted-foreground/25" />
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 flex flex-col items-center">
      <div
        data-testid="shared-hoot-avatar"
        className="h-7 w-7 rounded-full bg-accent flex items-center justify-center"
      >
        <HootIcon className="h-4 w-4 text-foreground" />
      </div>
      <div className="mt-1 flex-1 w-0.5 bg-accent-cyan/25" />
    </div>
  );
}

interface SharedConversationProps {
  messages: SharedMessage[];
  /** `preview` tightens spacing for the dialog's scroll box. */
  variant?: 'page' | 'preview';
}

export function SharedConversation({ messages, variant = 'page' }: SharedConversationProps) {
  const gap = variant === 'preview' ? 'space-y-4' : 'space-y-6';

  return (
    <div className={gap} data-testid="shared-conversation">
      {messages.map((message) => {
        const isUser = message.role === 'user';
        return (
          <div
            key={message.id}
            data-testid="shared-message"
            data-role={message.role}
            className={`flex gap-3 ${isUser ? 'justify-end' : ''}`}
          >
            {!isUser && <TurnAvatar role={message.role} />}

            <div className={`min-w-0 ${isUser ? 'max-w-[75%]' : 'flex-1'}`}>
              {/* 'user', never ChatWindow's "you": the one reading this is not its author. */}
              <div
                className={`flex items-center h-7 text-sm font-semibold text-foreground mb-1 ${isUser ? 'justify-end' : ''}`}
              >
                {isUser ? 'user' : 'hoot'}
              </div>

              <div className={isUser ? 'opacity-80 text-right' : ''}>
                {message.parts.map((part, i) => {
                  if (part.type === 'text') {
                    return <HootMarkdown key={i} text={part.text} />;
                  }

                  const outcome = OUTCOME[part.outcome];
                  const OutcomeIcon = outcome.icon;
                  // ToolCallCard's collapsed header, minus the expand: a snapshot
                  // has no inputs or outputs to open.
                  return (
                    <div
                      key={i}
                      data-testid="shared-tool"
                      className="my-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground"
                    >
                      <OutcomeIcon className={`h-4 w-4 flex-shrink-0 ${outcome.className}`} />
                      <Wrench className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="min-w-0 truncate">
                        ran <code className="text-foreground">{part.toolName}</code>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className={`flex-shrink-0 ${outcome.className}`}>{outcome.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {isUser && <TurnAvatar role={message.role} />}
          </div>
        );
      })}
    </div>
  );
}
