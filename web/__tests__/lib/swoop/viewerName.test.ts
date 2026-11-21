import { UNNAMED_VIEWER, viewerLabel } from '@/lib/swoop/viewerName';

describe('viewerLabel', () => {
  it('shortens a display name to the first name and last initial, and keeps the full name', () => {
    expect(viewerLabel({ displayName: 'Ada Lovelace', email: 'ada@example.test' })).toEqual({ short: 'Ada L.', full: 'Ada Lovelace' });
  });

  it('falls back to the email when there is no display name', () => {
    const label = viewerLabel({ displayName: null, email: 'ada@example.test' });
    expect(label.full).toBe('ada@example.test');
    expect(label.short).not.toBe(UNNAMED_VIEWER);
  });

  it('says viewer until the record names them', () => {
    expect(viewerLabel(null)).toEqual({ short: UNNAMED_VIEWER, full: UNNAMED_VIEWER });
    expect(viewerLabel({ displayName: '', email: null })).toEqual({ short: UNNAMED_VIEWER, full: UNNAMED_VIEWER });
  });
});
