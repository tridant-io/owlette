// The Hoot view is rendered by the persistent layout (app/hoot/layout.tsx),
// which derives the active chat id from the pathname. This page exists only so
// the /hoot route resolves.
//
// The tab title lives here rather than in that layout: the layout is a client
// component (it holds the chat view across /hoot <-> /hoot/[chatId]
// navigations), and a 'use client' module cannot export `metadata`.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'hoot',
};

export default function HootPage() {
  return null;
}
