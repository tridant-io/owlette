import { MAX_RECIPIENTS, normaliseRecipients } from '@/lib/activity/emailRecipients';

describe('normaliseRecipients', () => {
  it('trims, lowercases and keeps the order', () => {
    expect(normaliseRecipients(['  Ann@Example.test ', 'bob@example.test'])).toEqual({
      ok: true,
      recipients: ['ann@example.test', 'bob@example.test'],
    });
  });

  it('drops duplicates, whatever their case', () => {
    expect(normaliseRecipients(['a@example.test', 'A@example.test ', 'b@example.test'])).toEqual({
      ok: true,
      recipients: ['a@example.test', 'b@example.test'],
    });
  });

  it('takes an empty list', () => {
    expect(normaliseRecipients([])).toEqual({ ok: true, recipients: [] });
  });

  it('names every invalid entry', () => {
    expect(normaliseRecipients(['ok@example.test', 'nope', 'a b@example.test', 42])).toEqual({
      ok: false,
      invalid: ['nope', 'a b@example.test', '42'],
      tooMany: false,
    });
  });

  it('refuses what is not a list', () => {
    expect(normaliseRecipients('a@example.test')).toMatchObject({ ok: false });
    expect(normaliseRecipients(undefined)).toMatchObject({ ok: false });
  });

  it('caps the list at ten', () => {
    const ten = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `p${i}@example.test`);
    expect(normaliseRecipients(ten)).toMatchObject({ ok: true });
    expect(normaliseRecipients([...ten, 'p10@example.test'])).toEqual({ ok: false, invalid: [], tooMany: true });
  });

  it('counts the cap after duplicates are dropped', () => {
    const same = Array.from({ length: 12 }, () => 'a@example.test');
    expect(normaliseRecipients(same)).toEqual({ ok: true, recipients: ['a@example.test'] });
  });
});
