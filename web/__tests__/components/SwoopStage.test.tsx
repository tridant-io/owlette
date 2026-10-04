/**
 * @jest-environment jsdom
 */

/**
 * the stage says how to leave fullscreen only where that is not obvious: with
 * the keyboard captured a tap of esc goes to the machine, so the hint shows for
 * a few seconds when fullscreen engages in a browser that has keyboard lock,
 * and never in one that does not.
 *
 * windowed, every key goes to the machine, tab included, so the stage says the
 * way out — esc twice — each time it takes the keyboard, and sends focus where
 * the page says when it is used. and a touch drag on the stage is the
 * machine's: the page must not pan, or pull-to-refresh reload it mid-session.
 */

import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { SwoopStage } from '@/components/swoop/SwoopStage';

/** the input capture's escape-twice seam, or null for a view-only session. */
let mockCapture: { onEscapeTwice: (listener: () => void) => () => void } | null = null;
let escapeTwice: (() => void) | null = null;

jest.mock('@/lib/swoop/features', () => ({
  swoopInputCapture: () => mockCapture,
}));

function captureControl() {
  mockCapture = {
    onEscapeTwice: (listener) => {
      escapeTwice = listener;
      return () => {
        escapeTwice = null;
      };
    },
  };
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  mockCapture = null;
  escapeTwice = null;
  delete (navigator as Navigator & { keyboard?: unknown }).keyboard;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

function renderStage(props: Partial<React.ComponentProps<typeof SwoopStage>> = {}) {
  const stageRef = React.createRef<HTMLDivElement>();
  const videoRef = React.createRef<HTMLVideoElement>();
  render(<SwoopStage session={null} state="connected" stageRef={stageRef} videoRef={videoRef} {...props} />);
  return stageRef;
}

function enterFullscreen(stage: HTMLElement | null) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stage });
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
}

describe('SwoopStage esc hint', () => {
  it('shows the esc hold for four seconds when fullscreen engages with keyboard lock', () => {
    jest.useFakeTimers();
    (navigator as Navigator & { keyboard?: unknown }).keyboard = {
      lock: () => Promise.resolve(),
      unlock: () => {},
    };
    const stageRef = renderStage();
    expect(screen.queryByText(/hold esc/i)).toBeNull();

    enterFullscreen(stageRef.current);
    expect(screen.getByText(/hold esc for two seconds/i)).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(screen.queryByText(/hold esc/i)).toBeNull();
  });

  it('says nothing about esc in a browser without keyboard lock, where a tap already leaves', () => {
    const stageRef = renderStage();
    enterFullscreen(stageRef.current);
    expect(screen.queryByText(/hold esc/i)).toBeNull();
  });
});

describe('SwoopStage — leaving with the keyboard', () => {
  it('says esc twice leaves, for four seconds, when the stage takes the keyboard in a window', () => {
    jest.useFakeTimers();
    captureControl();
    const stageRef = renderStage();

    expect(stageRef.current).toHaveFocus();
    expect(screen.getByText('press esc twice to leave the remote screen')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('press esc twice to leave the remote screen')).toBeNull();
  });

  it('tells a screen reader the same, on a surface that passes its keys through', () => {
    captureControl();
    renderStage();

    expect(screen.getByRole('application', { name: 'remote screen' })).toHaveAccessibleDescription(
      'press escape twice to leave the remote screen',
    );
  });

  it('sends focus where the page says on escape twice', () => {
    captureControl();
    const onLeave = jest.fn();
    renderStage({ onLeave });

    act(() => escapeTwice?.());

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('lets go of focus on escape twice when the page names no place for it', () => {
    captureControl();
    const stageRef = renderStage();

    act(() => escapeTwice?.());

    expect(stageRef.current).not.toHaveFocus();
  });

  it('keeps quiet in fullscreen, which has its own exit', () => {
    captureControl();
    const stageRef = renderStage();
    enterFullscreen(stageRef.current);

    expect(screen.queryByText(/esc twice/)).toBeNull();
    expect(screen.getByRole('application')).not.toHaveAttribute('aria-describedby');
  });

  it('says nothing for a view-only session, whose keys never leave the page', () => {
    renderStage();

    expect(screen.queryByText(/esc twice/)).toBeNull();
    expect(screen.queryByRole('application')).toBeNull();
  });
});

describe('SwoopStage touch', () => {
  it('keeps touch gestures from panning the page or pulling it to refresh', () => {
    const stageRef = renderStage();

    expect(stageRef.current).toHaveClass('touch-none', 'overscroll-none');
  });
});

describe('SwoopStage theme', () => {
  it('keeps the video surface in the night palette whatever the page theme', () => {
    // jsdom computes no tokens, so the scoping class is the guard: without it a
    // light page turns the letterbox to paper and leaves the fullscreen hints
    // in light-theme grey on black.
    const stageRef = renderStage();

    expect(stageRef.current).toHaveClass('dark');
  });
});
