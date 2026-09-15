import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'hoot',
};

// The Hoot view is rendered by the persistent layout (app/hoot/layout.tsx),
// which derives the active chat id from the pathname. This page exists only so
// the /hoot/[chatId] route resolves.
export default function HootChatPage() {
  return null;
}
