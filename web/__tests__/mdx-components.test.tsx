/**
 * @jest-environment jsdom
 *
 * the docs img: a screenshot listed in light-variants.json renders as a themed
 * pair, anything else stays fumadocs' own image.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { getMDXComponents } from '@/mdx-components';

// virtual: jest's resolver can't read fumadocs' import-only exports map
jest.mock(
  'fumadocs-ui/mdx',
  () => ({
    __esModule: true,
    default: { img: (props: { alt?: string }) => <span data-testid="fumadocs-img" title={props.alt} /> },
  }),
  { virtual: true },
);
jest.mock('@/components/mdx/mermaid', () => ({ Mermaid: () => null }));
jest.mock('@/public/docs-screens/light-variants.json', () => ['machine-card']);

const Img = getMDXComponents().img as (props: Record<string, unknown>) => React.JSX.Element;

/** what remark-image hands the img: a static import, hashed by the bundler */
const staticImport = (name: string) => ({ src: `/_next/static/media/${name}.3x0c_w-1.png`, width: 800, height: 600 });

describe('docs img', () => {
  it('pairs a screenshot that has a light capture', () => {
    const { container } = render(<Img src={staticImport('machine-card')} alt="online machine card" />);
    const [dark, light] = Array.from(container.querySelectorAll('img'));

    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(dark).toHaveClass('hidden', 'dark:block', 'rounded-lg');
    expect(dark.getAttribute('src')).toContain(encodeURIComponent('/_next/static/media/machine-card.3x0c_w-1.png'));
    expect(light).toHaveClass('dark:hidden', 'rounded-lg');
    expect(light.getAttribute('src')).toContain(encodeURIComponent('/docs-screens/machine-card-light.png'));
    expect(light).toHaveAttribute('width', '800');
    expect(light).toHaveAttribute('alt', 'online machine card');
  });

  it('reads the name through the asset suffix next adds for a deployment id', () => {
    const shot = { ...staticImport('machine-card'), src: '/_next/static/media/machine-card.3x0c_w-1.png?dpl=abc' };
    const { container } = render(<Img src={shot} alt="online machine card" />);
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('leaves a screenshot without a light capture to fumadocs', () => {
    render(<Img src={staticImport('roost')} alt="roost list" />);
    expect(screen.getByTestId('fumadocs-img')).toHaveAttribute('title', 'roost list');
  });

  it('leaves an image that is not a static import to fumadocs', () => {
    render(<Img src="https://example.com/machine-card.png" alt="remote" />);
    expect(screen.getByTestId('fumadocs-img')).toBeInTheDocument();
  });
});
