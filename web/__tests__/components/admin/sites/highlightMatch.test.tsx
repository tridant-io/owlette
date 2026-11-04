/**
 * @jest-environment jsdom
 *
 * highlightMatch marks where a filter matched, so a filtered row shows why it
 * is in the list.
 */
import { render } from '@testing-library/react';
import { highlightMatch } from '@/components/admin/sites/highlightMatch';

function renderMatch(text: string, query: string) {
  const { container } = render(<span>{highlightMatch(text, query)}</span>);
  return {
    text: container.textContent,
    marks: Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent),
  };
}

describe('highlightMatch', () => {
  it('returns the text itself for an empty or blank query', () => {
    expect(highlightMatch('East Gate', '')).toBe('East Gate');
    expect(highlightMatch('East Gate', '   ')).toBe('East Gate');
  });

  it('marks each case-insensitive match once and keeps the text between them', () => {
    const { text, marks } = renderMatch('gate one, Gate two, GATE three', 'gate');
    expect(marks).toHaveLength(3);
    expect(text).toBe('gate one, Gate two, GATE three');
  });

  it('keeps the original casing inside each mark', () => {
    expect(renderMatch('gate one, Gate two, GATE three', ' GaTe ').marks).toEqual(['gate', 'Gate', 'GATE']);
  });
});
