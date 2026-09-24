/**
 * @jest-environment jsdom
 */

/**
 * the stage says how to leave fullscreen only where that is not obvious: with
 * the keyboard captured a tap of esc goes to the machine, so the hint shows for
 * a few seconds when fullscreen engages in a browser that has keyboard lock,
 * and never in one that does not.
 */

import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { SwoopStage } from '@/components/swoop/SwoopStage';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  delete (navigator as Navigator & { keyboard?: unknown }).keyboard;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

function renderStage() {
  const stageRef = React.createRef<HTMLDivElement>();
  const videoRef = React.createRef<HTMLVideoElement>();
  render(<SwoopStage session={null} state="connected" stageRef={stageRef} videoRef={videoRef} />);
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
