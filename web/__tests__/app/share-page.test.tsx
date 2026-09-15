/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The public share page — `/share/{token}` (hoot share, task B).
 *
 * Two contracts carry the weight here:
 *
 * 1. NO ORACLE. `getPublicChatShare` returns null for missing, expired and
 *    revoked alike, and the page has exactly one response to null: `notFound()`.
 *    The test asserts the call, not the rendering — a future "expired" branch
 *    would have to delete this assertion to pass, which is the point.
 *
 * 2. THE SNAPSHOT IS TEXT-ONLY. A tool call survives as a collapsed row naming
 *    the tool and how it ended; its inputs and outputs never reach the page.
 *    The assertion below is written as an ABSENCE (no output text anywhere in
 *    the document) because that is the leak that would matter.
 *
 * `robots: noindex` is asserted for the same reason: the unguessable token is
 * the whole access control, and an indexed share is a permanently public one.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import type { ChatShareView } from '@/lib/hoot/shareTypes';

// react-markdown and remark-gfm ship ESM only ("type": "module") and jest's
// transformIgnorePatterns leaves node_modules untransformed, so importing
// SharedConversation for real dies on `Unexpected token 'export'`. Markdown
// rendering is not what this suite covers — text in, text out.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => children,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

// The real icon behind a spy, so a test can tell which mark the header drew. It
// still renders for real: its `useId` runs inside the page's render here too.
jest.mock('@/components/landing/OwletteEye', () => {
  const actual = jest.requireActual('@/components/landing/OwletteEye');
  return { ...actual, OwletteEyeIcon: jest.fn(actual.OwletteEyeIcon) };
});

const getPublicChatShare = jest.fn();
jest.mock('@/lib/hoot/shareStore.server', () => ({
  getPublicChatShare: (...args: unknown[]) => getPublicChatShare(...args),
}));

/** Mirrors the real `notFound()`, which throws to abort the render. */
class NotFoundSignal extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
    this.name = 'NotFoundSignal';
  }
}
const notFound = jest.fn(() => {
  throw new NotFoundSignal();
});
jest.mock('next/navigation', () => ({
  notFound: () => notFound(),
}));

// The real ImageResponse rasterises through satori + resvg-wasm, which is far
// too heavy for a unit test and needs APIs jsdom does not provide. Standing in
// for it still exercises what this test is about: that the card's own control
// flow survives a share that does not resolve.
const imageResponses: unknown[] = [];
jest.mock('next/og', () => ({
  ImageResponse: class {
    constructor(element: unknown, options: unknown) {
      imageResponses.push({ element, options });
    }
  },
}));

const loggerError = jest.fn();
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args) },
}));

import SharePage, { generateMetadata } from '@/app/share/[token]/page';
import ShareNotFound from '@/app/share/[token]/not-found';
import ShareOpengraphImage from '@/app/share/[token]/opengraph-image';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';

const TOKEN = 'shr_AbCdEfGhIjKlMnOpQrStUv';

/** 2026-03-04 and 2026-04-03, both UTC. */
const CREATED_AT = Date.UTC(2026, 2, 4, 18, 30);
const EXPIRES_AT = Date.UTC(2026, 3, 3, 18, 30);

function share(overrides: Partial<ChatShareView> = {}): ChatShareView {
  return {
    token: TOKEN,
    title: 'why did the render node drop offline',
    targetLabel: 'GALLERY-NODE-04',
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'why did the render node drop offline last night?' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'tool', toolName: 'get_machine_logs', outcome: 'completed' },
          { type: 'text', text: 'the display driver crashed at 02:14 and the watchdog restarted it.' },
        ],
      },
    ],
    ...overrides,
  };
}

function props(token = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  imageResponses.length = 0;
});

describe('/share/[token] page', () => {
  it('renders the title, target label, dates and message text', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    expect(getPublicChatShare).toHaveBeenCalledWith(TOKEN);
    expect(
      screen.getByRole('heading', { name: 'why did the render node drop offline' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('GALLERY-NODE-04 · shared mar 4, 2026 · expires apr 3, 2026'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('why did the render node drop offline last night?'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('the display driver crashed at 02:14 and the watchdog restarted it.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/shared from owlette hoot — a read-only snapshot/),
    ).toBeInTheDocument();
  });

  it('renders a tool call as a collapsed row carrying no output', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    const tool = screen.getByTestId('shared-tool');
    // Exact, not `toHaveTextContent`: the row must be the tool's NAME and
    // OUTCOME and nothing else. A substring assertion would still pass if
    // someone rendered arguments or a result alongside them, which is the one
    // regression this row exists to prevent.
    expect(tool.textContent).toBe('ran get_machine_logs·completed');
  });

  it('heads the page with the owlette mark, linking home as "owlette hoot"', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    expect(screen.getByRole('link', { name: 'owlette hoot' })).toHaveAttribute(
      'href',
      'https://owlette.app',
    );
    // The mark PageHeader draws, at PageHeader's size — not hoot's owl glyph.
    expect(jest.mocked(OwletteEyeIcon).mock.calls[0]?.[0]).toMatchObject({ size: 24 });
  });

  it('sets the conversation in a chat panel, between the heading and the footnote', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    const panel = screen.getByTestId('shared-conversation-panel');
    expect(panel).toContainElement(screen.getByTestId('shared-conversation'));
    expect(panel).not.toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(panel).not.toContainElement(
      screen.getByText(/shared from owlette hoot — a read-only snapshot/),
    );
  });

  it('scrolls wide content inside the panel rather than past its border', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    // jsdom does no layout, so the utility itself is the only thing to assert:
    // without it a markdown table wider than a phone's column crosses the
    // panel's border and is clipped by body's overflow-x: hidden.
    expect(screen.getByTestId('shared-conversation-panel')).toHaveClass('overflow-x-auto');
  });

  it('frames hoot turns with the hoot avatar and user turns with a generic one', async () => {
    getPublicChatShare.mockResolvedValue(share());

    render(await SharePage(props()));

    // One element per message: the e2e spec counts them.
    const turns = screen.getAllByTestId('shared-message');
    expect(turns).toHaveLength(2);
    const [userTurn, hootTurn] = turns;

    expect(userTurn).toHaveAttribute('data-role', 'user');
    expect(within(userTurn).getByText('user')).toBeInTheDocument();
    expect(within(userTurn).queryByTestId('shared-hoot-avatar')).toBeNull();
    // A snapshot carries no author identity: a glyph, never initials or a name.
    expect(within(userTurn).getByTestId('shared-user-avatar').textContent).toBe('');

    expect(hootTurn).toHaveAttribute('data-role', 'assistant');
    expect(within(hootTurn).getByText('hoot')).toBeInTheDocument();
    expect(within(hootTurn).getByTestId('shared-hoot-avatar')).toBeInTheDocument();
    expect(within(hootTurn).queryByTestId('shared-user-avatar')).toBeNull();
  });

  it('labels a site-wide share and one that never expires', async () => {
    getPublicChatShare.mockResolvedValue(share({ targetLabel: null, expiresAt: null }));

    render(await SharePage(props()));

    expect(
      screen.getByText('all machines · shared mar 4, 2026 · never expires'),
    ).toBeInTheDocument();
  });

  it('calls notFound() when the share does not resolve', async () => {
    getPublicChatShare.mockResolvedValue(null);

    await expect(SharePage(props())).rejects.toThrow(NotFoundSignal);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe('/share/[token] generateMetadata', () => {
  it('is noindex and describes the share by its opening message', async () => {
    getPublicChatShare.mockResolvedValue(share());

    const metadata = await generateMetadata(props());

    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true });
    // `absolute`, not a bare string: the root layout templates titles as
    // "owlette - %s", and this one already carries the brand. Asserting the
    // shape is the point — a plain string here would silently become
    // "owlette - … — shared from owlette hoot" on a public page.
    expect(metadata.title).toEqual({
      absolute: 'why did the render node drop offline — shared from owlette hoot',
    });
    expect(metadata.description).toBe('why did the render node drop offline last night?');
    expect(metadata.openGraph).toMatchObject({ type: 'article' });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
    // og:image comes from the colocated opengraph-image.tsx, and only while no
    // `images` key is declared here. Naming one would replace the card.
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });

  it('truncates a long opening message to 160 characters', async () => {
    const long = `${'a'.repeat(400)}`;
    getPublicChatShare.mockResolvedValue(
      share({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: long }] }] }),
    );

    const metadata = await generateMetadata(props());

    expect(metadata.description).toHaveLength(160);
    expect(metadata.description).toMatch(/…$/);
  });

  it('falls back when the share opens with no user text', async () => {
    getPublicChatShare.mockResolvedValue(
      share({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'tool', toolName: 'list_machines', outcome: 'completed' }],
          },
        ],
      }),
    );

    const metadata = await generateMetadata(props());

    expect(metadata.description).toBe('a hoot conversation shared from owlette');
  });

  it('stays noindex and says nothing about why a share is gone', async () => {
    getPublicChatShare.mockResolvedValue(null);

    const metadata = await generateMetadata(props());

    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true });
    expect(metadata.title).toEqual({ absolute: 'shared conversation not available' });
    expect(String(metadata.description)).not.toMatch(/revoked|deleted/i);
  });
});

describe('/share/[token] not-found', () => {
  it('renders the same copy for every dead link', () => {
    render(<ShareNotFound />);

    expect(
      screen.getByRole('heading', { name: "this shared conversation isn't available" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('it may have expired, or the person who shared it removed the link.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'owlette.app' })).toHaveAttribute(
      'href',
      'https://owlette.app',
    );
  });
});

describe('/share/[token] opengraph-image', () => {
  it('returns a card for a share that does not resolve, rather than throwing', async () => {
    getPublicChatShare.mockResolvedValue(null);

    await expect(ShareOpengraphImage(props())).resolves.toBeDefined();
    expect(imageResponses).toHaveLength(1);
  });

  it('swallows a store failure into the same generic card', async () => {
    getPublicChatShare.mockRejectedValue(new Error('firestore unavailable'));

    await expect(ShareOpengraphImage(props())).resolves.toBeDefined();
    expect(imageResponses).toHaveLength(1);
    expect(loggerError).toHaveBeenCalled();
  });
});
