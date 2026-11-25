/**
 * @jest-environment node
 */
import {
  SWOOP_MODES,
  effectiveSwoopMode,
  grantedSwoopMode,
  parseSwoopMode,
  type SwoopMode,
} from '@/lib/swoopMode';

describe('parseSwoopMode', () => {
  it('reads an absent field as no mode, so the role decides', () => {
    expect(parseSwoopMode(undefined)).toBeNull();
  });

  it.each(SWOOP_MODES)('reads %s as itself', (mode) => {
    expect(parseSwoopMode(mode)).toBe(mode);
  });

  // fails closed: a hand-edited value never reads as a grant
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a capitalised mode', 'Control'],
    ['a number', 1],
    ['an object', {}],
  ])('reads %s as none', (_label, raw) => {
    expect(parseSwoopMode(raw)).toBe('none');
  });
});

type Role = 'owner' | 'admin' | 'member';

/** role, mode (null is absent), membersMayWatch, granted, effective */
const TABLE: Array<[Role, SwoopMode | null, boolean, SwoopMode, SwoopMode]> = [
  ['owner', null, true, 'control', 'control'],
  ['owner', null, false, 'control', 'control'],
  ['owner', 'none', true, 'control', 'control'],
  ['owner', 'none', false, 'control', 'control'],
  ['owner', 'view', true, 'control', 'control'],
  ['owner', 'view', false, 'control', 'control'],
  ['owner', 'control', true, 'control', 'control'],
  ['owner', 'control', false, 'control', 'control'],
  ['admin', null, true, 'control', 'control'],
  ['admin', null, false, 'control', 'control'],
  ['admin', 'none', true, 'none', 'none'],
  ['admin', 'none', false, 'none', 'none'],
  ['admin', 'view', true, 'view', 'view'],
  ['admin', 'view', false, 'view', 'view'],
  ['admin', 'control', true, 'control', 'control'],
  ['admin', 'control', false, 'control', 'control'],
  ['member', null, true, 'view', 'view'],
  ['member', null, false, 'view', 'none'],
  ['member', 'none', true, 'none', 'none'],
  ['member', 'none', false, 'none', 'none'],
  ['member', 'view', true, 'view', 'view'],
  ['member', 'view', false, 'view', 'view'],
  ['member', 'control', true, 'control', 'control'],
  ['member', 'control', false, 'control', 'control'],
];

describe('grantedSwoopMode and effectiveSwoopMode', () => {
  it.each(TABLE)(
    '%s with mode %s, membersMayWatch %s: granted %s, effective %s',
    (role, mode, membersMayWatch, granted, effective) => {
      expect(grantedSwoopMode(role, mode)).toBe(granted);
      expect(effectiveSwoopMode(role, mode, membersMayWatch)).toBe(effective);
    },
  );
});
