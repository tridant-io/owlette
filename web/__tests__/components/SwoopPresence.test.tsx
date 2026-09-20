/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the overlay. two things here can be wrong in a way nobody notices: drawing
 * this browser's own pointer, which reads as lag that is not there, and
 * positioning against the stage instead of the picture, which is right on a
 * matching aspect ratio and wrong by a growing offset on every other one.
 */

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { SwoopPresence, tintOf } from '@/components/swoop/SwoopPresence';
import { attach } from '@/lib/swoop/presence';
import type { SwoopSession } from '@/lib/swoop/features';

const ROSTER = [
  { id: 'viewer-a', name: 'uid_operator', ctl: true },
  { id: 'viewer-b', name: 'uid_watcher', ctl: false },
  { id: 'viewer-me', name: 'uid_me', ctl: true },
];

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

interface Harness {
  session: SwoopSession;
  control(data: string): void;
  cursor(data: string): void;
  detach(): void;
}

/**
 * a 16:9 picture letterboxed inside a taller stage — the case that catches
 * anyone normalising against the element rect.
 */
function harness(): Harness {
  const handlers = new Map<string, (data: unknown) => void>();
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800);

  const session = {
    viewerId: 'viewer-me',
    stage,
    video: document.createElement('video'),
    contentRect: () => rect(0, 81, 1000, 638),
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => {
        handlers.delete(label);
      };
    },
  } as unknown as SwoopSession;

  const detach = attach(session);
  return {
    session,
    control: (data) => act(() => handlers.get('swoop-control')?.(data)),
    cursor: (data) => act(() => handlers.get('swoop-cursor')?.(data)),
    detach,
  };
}

afterEach(cleanup);

describe('SwoopPresence', () => {
  it('shows nothing without a session', () => {
    const { container } = render(<SwoopPresence session={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing while this viewer is alone', () => {
    const h = harness();
    const { container } = render(<SwoopPresence session={h.session} />);
    h.control(JSON.stringify({ t: 'roster', viewers: [ROSTER[2]], tsUs: 1 }));
    expect(container).toBeEmptyDOMElement();
    h.detach();
  });

  it('names everyone connected and says who is view only', () => {
    const h = harness();
    render(<SwoopPresence session={h.session} />);
    h.control(JSON.stringify({ t: 'roster', viewers: ROSTER, tsUs: 1 }));

    const lines = screen.getByLabelText('viewers').textContent ?? '';
    expect(lines).toContain('uid_operator');
    expect(lines).toContain('uid_watcher· view only');
    expect(lines).toContain('uid_me (you)');
    h.detach();
  });

  it('places another viewer cursor over the picture, not the element', () => {
    const h = harness();
    const { container } = render(<SwoopPresence session={h.session} />);
    h.control(JSON.stringify({ t: 'roster', viewers: ROSTER, tsUs: 1 }));
    h.cursor(JSON.stringify({ t: 'vpos', viewer: 'viewer-a', x: 0.5, y: 0.5, tsUs: 2 }));

    const cursor = container.querySelector<HTMLElement>('div[aria-hidden]');
    expect(cursor).not.toBeNull();
    // the picture is inset 81px from the top of the stage, and the `size - 1`
    // convention is the one the rust injection side matches.
    expect(cursor?.style.left).toBe(`${0.5 * 999}px`);
    expect(cursor?.style.top).toBe(`${81 + 0.5 * 637}px`);
    h.detach();
  });

  it('never draws this browser own pointer', () => {
    const h = harness();
    const { container } = render(<SwoopPresence session={h.session} />);
    h.control(JSON.stringify({ t: 'roster', viewers: ROSTER, tsUs: 1 }));
    h.cursor(JSON.stringify({ t: 'vpos', viewer: 'viewer-me', x: 0.5, y: 0.5, tsUs: 2 }));
    expect(container.querySelector('div[aria-hidden]')).toBeNull();
    h.detach();
  });

  it('gives a viewer the same tint every time', () => {
    expect(tintOf('viewer-a')).toBe(tintOf('viewer-a'));
    expect(tintOf('viewer-a')).toMatch(/^text-chart-[1-5]$/);
  });
});
