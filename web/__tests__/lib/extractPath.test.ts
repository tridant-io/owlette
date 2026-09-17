/** @jest-environment node */

/**
 * Tests for extractPath.ts: resolveExtractPath's three branches (default,
 * absolute verbatim, relative under ~/Documents) and isLikelyAllowed's per-OS
 * verdict, which mirrors the agent's `destination_allowlist` default roots.
 */

import {
  DEFAULT_EXTRACT_PATH,
  isLikelyAllowed,
  isPosixPathOnWindowsTargets,
  resolveExtractPath,
} from '@/lib/extractPath';
import type { MachineOsFamily } from '@/lib/machineOs';

const windows: ReadonlySet<MachineOsFamily> = new Set(['windows']);
const macos: ReadonlySet<MachineOsFamily> = new Set(['macos']);
const linux: ReadonlySet<MachineOsFamily> = new Set(['linux']);
const nothingSelected: ReadonlySet<MachineOsFamily> = new Set();

describe('resolveExtractPath', () => {
  it('falls back to the default landing pad when empty', () => {
    expect(resolveExtractPath('')).toBe(DEFAULT_EXTRACT_PATH);
    expect(resolveExtractPath('   ')).toBe(DEFAULT_EXTRACT_PATH);
  });

  it('keeps a drive-letter path verbatim, normalising separators', () => {
    expect(resolveExtractPath('C:\\render')).toBe('C:\\render');
    expect(resolveExtractPath('D:/shows/spring')).toBe('D:\\shows\\spring');
  });

  it('keeps a POSIX absolute path verbatim', () => {
    // the operator typed a path their mac or linux agent can use as typed;
    // burying it under ~/Documents would send the files somewhere else.
    expect(resolveExtractPath('/opt/exhibit')).toBe('/opt/exhibit');
    expect(resolveExtractPath('/var/lib/owlette/projects/show1')).toBe(
      '/var/lib/owlette/projects/show1',
    );
    expect(resolveExtractPath('/Users/Shared/Owlette/show1')).toBe(
      '/Users/Shared/Owlette/show1',
    );
  });

  it('nests a relative path directly under Documents', () => {
    expect(resolveExtractPath('show1')).toBe('~/Documents/show1/');
    expect(resolveExtractPath('projects/show1/')).toBe('~/Documents/projects/show1/');
    expect(resolveExtractPath('\\render')).toBe('~/Documents/render/');
  });
});

describe('isLikelyAllowed', () => {
  it('accepts the empty default on every OS', () => {
    // the agent rescues this one itself: the fanout sends the windows default
    // to every target and a POSIX agent substitutes its own default root.
    for (const targets of [windows, macos, linux]) {
      expect(isLikelyAllowed('', targets)).toBe(true);
    }
  });

  it('measures a relative path against the target OS root', () => {
    // `show1` resolves to `~/Documents/show1/` — under the windows default
    // root, under neither POSIX one, and outside the one literal the agent
    // substitutes, so those targets get the warning.
    expect(isLikelyAllowed('show1', windows)).toBe(true);
    expect(isLikelyAllowed('show1', macos)).toBe(false);
    expect(isLikelyAllowed('show1', linux)).toBe(false);
  });

  it('refuses a drive-letter path — no OS allows one by default', () => {
    expect(isLikelyAllowed('C:\\render', windows)).toBe(false);
    expect(isLikelyAllowed('C:\\render', macos)).toBe(false);
    expect(isLikelyAllowed('C:\\render', linux)).toBe(false);
  });

  it('warns for an absolute path outside the linux default root', () => {
    expect(isLikelyAllowed('/opt/exhibit', linux)).toBe(false);
  });

  it('accepts a path at or under the target OS default root', () => {
    expect(isLikelyAllowed('/var/lib/owlette/projects', linux)).toBe(true);
    expect(isLikelyAllowed('/var/lib/owlette/projects/show1', linux)).toBe(true);
    expect(isLikelyAllowed('/Users/Shared/Owlette', macos)).toBe(true);
    expect(isLikelyAllowed('/Users/Shared/Owlette/show1', macos)).toBe(true);
  });

  it('measures each OS against its own root, not another OS\'s', () => {
    expect(isLikelyAllowed('/var/lib/owlette/projects/show1', macos)).toBe(false);
    expect(isLikelyAllowed('/Users/Shared/Owlette/show1', linux)).toBe(false);
    expect(isLikelyAllowed('/Users/Shared/Owlette/show1', windows)).toBe(false);
  });

  it('warns when any machine in a mixed selection would refuse', () => {
    const mixed: ReadonlySet<MachineOsFamily> = new Set(['macos', 'linux']);
    expect(isLikelyAllowed('/var/lib/owlette/projects/show1', mixed)).toBe(false);
    expect(isLikelyAllowed('/Users/Shared/Owlette/show1', mixed)).toBe(false);
    expect(isLikelyAllowed('show1', mixed)).toBe(false);
  });

  it('does not treat a sibling directory as being under the root', () => {
    expect(isLikelyAllowed('/var/lib/owlette/projects-old/show1', linux)).toBe(false);
    expect(isLikelyAllowed('/Users/Shared/OwletteOther', macos)).toBe(false);
  });

  it('measures an empty selection against the windows root', () => {
    // the field sits above the target picker, so "nothing ticked yet" is the
    // normal state while the operator types. an absent osFamily is windows.
    expect(isLikelyAllowed('C:\\render', nothingSelected)).toBe(false);
    expect(isLikelyAllowed('/opt/exhibit', nothingSelected)).toBe(false);
    expect(isLikelyAllowed('show1', nothingSelected)).toBe(true);
  });
});

describe('isPosixPathOnWindowsTargets', () => {
  it('flags a POSIX path aimed only at windows machines', () => {
    // windows refuses `/renders` as "not absolute" before the allowlist is
    // consulted, so the allowlist remediation the dialog prints cannot help.
    expect(isPosixPathOnWindowsTargets('/renders', windows)).toBe(true);
    expect(isPosixPathOnWindowsTargets('/renders', nothingSelected)).toBe(true);
  });

  it('leaves every other input to the allowlist warning', () => {
    expect(isPosixPathOnWindowsTargets('/renders', linux)).toBe(false);
    expect(isPosixPathOnWindowsTargets('/renders', new Set(['windows', 'linux']))).toBe(
      false,
    );
    expect(isPosixPathOnWindowsTargets('C:\\render', windows)).toBe(false);
    expect(isPosixPathOnWindowsTargets('show1', windows)).toBe(false);
    expect(isPosixPathOnWindowsTargets('', windows)).toBe(false);
  });
});
