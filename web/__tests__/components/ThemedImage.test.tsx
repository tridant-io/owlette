/**
 * @jest-environment jsdom
 *
 * ThemedImage: each theme's capture renders and the theme class shows one. both
 * load lazily so the hidden one is never fetched, and a preloaded pair preloads
 * each capture only under its own prefers-color-scheme.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { preload } from 'react-dom';
import { ThemedImage } from '@/components/ThemedImage';

jest.mock('react-dom', () => ({ ...jest.requireActual('react-dom'), preload: jest.fn() }));

const base = { alt: 'dashboard', width: 1920, height: 1080, sizes: '100vw', className: 'w-full' };

describe('ThemedImage', () => {
  it('renders both captures, each shown only in its theme and both lazy', () => {
    const { container } = render(<ThemedImage {...base} dark="/shots/a.png" light="/shots/a-light.png" />);
    const [dark, light] = Array.from(container.querySelectorAll('img'));

    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(dark).toHaveClass('hidden', 'dark:block', 'w-full');
    expect(dark.getAttribute('src')).toContain('a.png');
    expect(light).toHaveClass('dark:hidden', 'w-full');
    expect(light).not.toHaveClass('hidden');
    expect(light.getAttribute('src')).toContain('a-light.png');
    for (const img of [dark, light]) expect(img).toHaveAttribute('loading', 'lazy');
    expect(preload).not.toHaveBeenCalled();
  });

  it('preloads each capture under its own color scheme, never both unscoped', () => {
    render(<ThemedImage {...base} dark="/shots/a.png" light="/shots/a-light.png" preload fetchPriority="high" />);

    expect(preload).toHaveBeenCalledTimes(2);
    expect(preload).toHaveBeenCalledWith(
      expect.stringContaining('a.png'),
      expect.objectContaining({ as: 'image', media: '(prefers-color-scheme: dark)', fetchPriority: 'high' }),
    );
    expect(preload).toHaveBeenCalledWith(
      expect.stringContaining('a-light.png'),
      expect.objectContaining({ as: 'image', media: '(prefers-color-scheme: light)', fetchPriority: 'high' }),
    );
    // the srcset the browser picks from matches the one the img renders
    const darkCall = jest.mocked(preload).mock.calls.find(([, options]) => options.media?.includes('dark'));
    expect(darkCall?.[1].imageSrcSet).toContain('a.png');
    expect(darkCall?.[1].imageSizes).toBe('100vw');
  });

  it('renders one eager image while the light capture is still the dark one', () => {
    const { container } = render(<ThemedImage {...base} dark="/shots/a.png" light="/shots/a.png" preload />);
    const imgs = container.querySelectorAll('img');

    expect(imgs).toHaveLength(1);
    expect(imgs[0]).not.toHaveAttribute('loading', 'lazy');
    expect(imgs[0]).not.toHaveClass('hidden');
    // next/image's own preload, unscoped, exactly as a plain preloaded Image
    expect(preload).toHaveBeenCalledTimes(1);
    expect(jest.mocked(preload).mock.calls[0][1].media).toBeUndefined();
  });
});
