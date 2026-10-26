/**
 * The CLI's agent version check. It must agree with web's `compareVersions`
 * (web/lib/versionUtils.ts), which the API uses to decide the same question.
 */

import { isAgentVersionAtLeast } from '../../src/lib/agentVersion';

describe('isAgentVersionAtLeast', () => {
  it.each(['4.1.21', '4.1.22', '4.2.0', '5.0.0', 'v4.1.21', ' 4.1.21 ', '4.1.22-beta'])('%s is at least 4.1.21', (version) => {
    expect(isAgentVersionAtLeast(version, '4.1.21')).toBe(true);
  });

  it.each(['3.3.7', '4.1.20', '4.0.99', '4.1.21-beta'])('%s is below 4.1.21', (version) => {
    // a prerelease sits below its release, as in web
    expect(isAgentVersionAtLeast(version, '4.1.21')).toBe(false);
  });

  it.each([undefined, null, '', 'unknown', 'legacy', '4.1', 4.1, {}])('%p is never at least 4.1.21', (version) => {
    expect(isAgentVersionAtLeast(version, '4.1.21')).toBe(false);
  });

  it('orders prereleases alphabetically, as web does', () => {
    expect(isAgentVersionAtLeast('4.1.21-rc', '4.1.21-beta')).toBe(true);
    expect(isAgentVersionAtLeast('4.1.21-alpha', '4.1.21-beta')).toBe(false);
    expect(isAgentVersionAtLeast('4.1.21', '4.1.21-beta')).toBe(true);
  });
});
