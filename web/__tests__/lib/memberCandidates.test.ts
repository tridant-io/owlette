import {
  candidateLabel,
  isFullEmail,
  rankMemberCandidates,
  type MemberCandidate,
} from '@/lib/memberCandidates';

const uids = (candidates: readonly MemberCandidate[]) => candidates.map((c) => c.uid);

// for "cal": jo and pascal hold it mid-word, rae starts a display-name word with it, cal starts the email
const jo: MemberCandidate = { uid: 'jo', email: 'jo.mcallister@example.com', displayName: 'Jo Mcallister' };
const rae: MemberCandidate = { uid: 'rae', email: 'rae@example.com', displayName: 'Rae Calloway' };
const pascal: MemberCandidate = { uid: 'pascal', email: 'pascal@example.com', displayName: null };
const cal: MemberCandidate = { uid: 'cal', email: 'cal.ortiz@example.com', displayName: 'Cal Ortiz' };
const unnamed: MemberCandidate = { uid: 'unnamed', email: null, displayName: null };
const people = [jo, rae, pascal, cal, unnamed];

describe('candidateLabel', () => {
  it('prefers the email, then the display name, then "this person"', () => {
    expect(candidateLabel(rae)).toBe('rae@example.com');
    expect(candidateLabel({ ...rae, email: null })).toBe('Rae Calloway');
    expect(candidateLabel({ ...rae, email: '', displayName: '' })).toBe('this person');
    expect(candidateLabel(unnamed)).toBe('this person');
  });
});

describe('isFullEmail', () => {
  it('accepts a full address, ignoring surrounding whitespace', () => {
    expect(isFullEmail('rae@example.com')).toBe(true);
    expect(isFullEmail('  rae@example.com  ')).toBe(true);
  });

  it('rejects text with no @', () => {
    expect(isFullEmail('rae.example.com')).toBe(false);
  });

  it('rejects a domain with no dot', () => {
    expect(isFullEmail('rae@example')).toBe(false);
  });

  it('rejects spaces inside the address', () => {
    expect(isFullEmail('rae calloway@example.com')).toBe(false);
    expect(isFullEmail('rae@example .com')).toBe(false);
  });

  it('rejects an address that is still being typed', () => {
    expect(isFullEmail('')).toBe(false);
    expect(isFullEmail('rae@')).toBe(false);
    expect(isFullEmail('rae@example.')).toBe(false);
  });

  it('accepts 254 characters after trimming and rejects 255', () => {
    const domain = '@example.com';
    const at254 = 'a'.repeat(254 - domain.length) + domain;
    const at255 = 'a'.repeat(255 - domain.length) + domain;
    expect(at254).toHaveLength(254);
    expect(at255).toHaveLength(255);
    expect(isFullEmail(at254)).toBe(true);
    expect(isFullEmail(`  ${at254}  `)).toBe(true);
    expect(isFullEmail(at255)).toBe(false);
  });
});

describe('rankMemberCandidates', () => {
  it('puts prefix matches before substring matches, keeping the given order within each', () => {
    expect(uids(rankMemberCandidates('cal', people))).toEqual(['rae', 'cal', 'jo', 'pascal']);
  });

  it('finds "rae calloway" from "cal" in the prefix group, through a display-name word', () => {
    expect(uids(rankMemberCandidates('cal', [jo, rae]))).toEqual(['rae', 'jo']);
  });

  it('matches a display name from its start, across words', () => {
    expect(uids(rankMemberCandidates('rae cal', people))).toEqual(['rae']);
  });

  it('matches case-insensitively', () => {
    expect(uids(rankMemberCandidates('CAL', people))).toEqual(['rae', 'cal', 'jo', 'pascal']);
    expect(uids(rankMemberCandidates('  Rae@Example.COM ', people))).toEqual(['rae']);
  });

  it('returns nothing when no email or display name holds the query', () => {
    expect(rankMemberCandidates('projector', people)).toEqual([]);
    expect(rankMemberCandidates('a', [unnamed])).toEqual([]);
  });

  it('returns the first 6 in the given order for an empty query', () => {
    const many: MemberCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      uid: `u${i}`,
      email: `tech${i}@example.com`,
      displayName: null,
    }));
    expect(uids(rankMemberCandidates('', many))).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5']);
    expect(rankMemberCandidates('   ', many)).toEqual(many.slice(0, 6));
  });

  it('caps the result at the limit, filling it with prefix matches first', () => {
    const inside: MemberCandidate[] = Array.from({ length: 4 }, (_, i) => ({
      uid: `in${i}`,
      email: `mcal${i}@example.com`,
      displayName: null,
    }));
    const starts: MemberCandidate[] = Array.from({ length: 4 }, (_, i) => ({
      uid: `at${i}`,
      email: `cal${i}@example.com`,
      displayName: null,
    }));
    const all = [...inside, ...starts];
    expect(uids(rankMemberCandidates('cal', all))).toEqual(['at0', 'at1', 'at2', 'at3', 'in0', 'in1']);
    expect(uids(rankMemberCandidates('cal', all, 3))).toEqual(['at0', 'at1', 'at2']);
  });
});
