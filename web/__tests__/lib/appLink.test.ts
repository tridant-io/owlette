import { safeNextPath } from '@/lib/appLink';

describe('safeNextPath', () => {
  it('keeps a same-origin path', () => {
    expect(safeNextPath('/swoop/s1/m1')).toBe('/swoop/s1/m1');
    expect(safeNextPath('/roost?x=1', '/dashboard')).toBe('/roost?x=1');
  });

  it.each([null, '', 'swoop', 'https://evil.example', '//evil.example', '/\\evil.example'])(
    'falls back for %p',
    (value) => {
      expect(safeNextPath(value)).toBe('/swoop');
      expect(safeNextPath(value, '/dashboard')).toBe('/dashboard');
    },
  );
});
