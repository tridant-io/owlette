import { osLabelCandidates } from '@/lib/osLabel';

describe('osLabelCandidates', () => {
  it('shortens windows to Win, then drops the feature-update id', () => {
    expect(osLabelCandidates('Windows 11 Pro 23H2')).toEqual([
      'Windows 11 Pro 23H2',
      'Win 11 Pro 23H2',
      'Win 11 Pro',
    ]);
  });

  it('drops LTS, then one dotted version component at a time', () => {
    expect(osLabelCandidates('Ubuntu 24.04.5 LTS')).toEqual([
      'Ubuntu 24.04.5 LTS',
      'Ubuntu 24.04.5',
      'Ubuntu 24.04',
      'Ubuntu 24',
    ]);
  });

  it('skips steps that change nothing', () => {
    expect(osLabelCandidates('Windows Server 2022')).toEqual([
      'Windows Server 2022',
      'Win Server 2022',
      'Win Server',
    ]);
    expect(osLabelCandidates('macOS 15.1')).toEqual(['macOS 15.1', 'macOS 15']);
    expect(osLabelCandidates('Debian')).toEqual(['Debian']);
  });

  it('normalises whitespace and never yields an empty form', () => {
    expect(osLabelCandidates('  Ubuntu   22.04  LTS ')).toEqual([
      'Ubuntu 22.04 LTS',
      'Ubuntu 22.04',
      'Ubuntu 22',
    ]);
  });
});
