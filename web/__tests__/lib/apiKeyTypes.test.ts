/**
 * @jest-environment node
 *
 * Unit coverage for the scope-grammar primitives in `web/lib/apiKeyTypes.ts`.
 * Exercises every (resource, permission) combination across the full
 * vocabulary so api-sprint waves 1-3 can rely on the grammar without
 * relitigating shape decisions per-track.
 */
import {
  ALL_RESOURCES,
  SCOPE_PRESETS,
  SUPERADMIN_ONLY_RESOURCES,
  SUPERADMIN_ONLY_RESOURCES_LABEL,
  scopeMatches,
  type ApiKeyScope,
} from '@/lib/apiKeyTypes';

describe('ALL_RESOURCES', () => {
  it('contains every resource type the api-sprint vocabulary expects', () => {
    expect(ALL_RESOURCES).toEqual([
      'roost',
      'site',
      'machine',
      'chat',
      'deploy',
      'process',
      'user',
      'installer',
      'issue',
    ]);
  });

  it('flags `user`, `installer` and `issue` as superadmin-only', () => {
    expect([...SUPERADMIN_ONLY_RESOURCES].sort()).toEqual(['installer', 'issue', 'user']);
  });

  it('names every superadmin-only resource in the 403 wording', () => {
    expect(SUPERADMIN_ONLY_RESOURCES_LABEL).toBe('user, installer or issue');
  });
});

describe('SCOPE_PRESETS', () => {
  it('includes chat in common CLI/dashboard presets', () => {
    expect(SCOPE_PRESETS.publisher.map((scope) => scope.resource).sort()).toEqual([
      'chat',
      'machine',
      'roost',
      'site',
    ]);
    expect(SCOPE_PRESETS.publisher.find((scope) => scope.resource === 'chat')).toEqual({
      resource: 'chat',
      id: '*',
      permissions: ['read', 'write'],
    });
  });
});

describe('scopeMatches — existing resources', () => {
  it('matches exact (resource, id, permission)', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'roost', id: 'rst_abc', permissions: ['read', 'write'] },
    ];
    expect(scopeMatches(scopes, 'roost', 'rst_abc', 'read')).toBe(true);
    expect(scopeMatches(scopes, 'roost', 'rst_abc', 'write')).toBe(true);
  });

  it('rejects when the permission is not granted', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'roost', id: 'rst_abc', permissions: ['read'] },
    ];
    expect(scopeMatches(scopes, 'roost', 'rst_abc', 'write')).toBe(false);
  });

  it('rejects when the id does not match', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'roost', id: 'rst_abc', permissions: ['read'] },
    ];
    expect(scopeMatches(scopes, 'roost', 'rst_xyz', 'read')).toBe(false);
  });

  it('wildcard id (`*`) matches any specific id', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'site', id: '*', permissions: ['read'] },
    ];
    expect(scopeMatches(scopes, 'site', 'site_anything', 'read')).toBe(true);
  });

  it('rejects when resource type does not match', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'roost', id: '*', permissions: ['read'] },
    ];
    expect(scopeMatches(scopes, 'site', 'site_x', 'read')).toBe(false);
  });
});

describe('scopeMatches — new api-sprint resources', () => {
  // Each new resource gets one positive match + one mismatch.
  const cases: ReadonlyArray<{
    label: string;
    scope: ApiKeyScope;
    matchId: string;
    mismatchId: string;
  }> = [
    {
      label: 'chat (site-scoped)',
      scope: { resource: 'chat', id: 'site_kiosk', permissions: ['write'] },
      matchId: 'site_kiosk',
      mismatchId: 'site_other',
    },
    {
      label: 'deploy (site-scoped)',
      scope: { resource: 'deploy', id: 'site_kiosk', permissions: ['write'] },
      matchId: 'site_kiosk',
      mismatchId: 'site_other',
    },
    {
      label: 'process (machine-scoped)',
      scope: { resource: 'process', id: 'mach_abc', permissions: ['admin'] },
      matchId: 'mach_abc',
      mismatchId: 'mach_xyz',
    },
    {
      label: 'user (uid-scoped)',
      scope: { resource: 'user', id: 'uid_admin', permissions: ['write'] },
      matchId: 'uid_admin',
      mismatchId: 'uid_other',
    },
    {
      label: 'installer (version-scoped)',
      scope: { resource: 'installer', id: '2.10.0', permissions: ['admin'] },
      matchId: '2.10.0',
      mismatchId: '2.9.0',
    },
  ];

  it.each(cases)('$label — exact id matches', ({ scope, matchId }) => {
    expect(scopeMatches([scope], scope.resource, matchId, scope.permissions[0]!)).toBe(true);
  });

  it.each(cases)('$label — different id is rejected', ({ scope, mismatchId }) => {
    expect(
      scopeMatches([scope], scope.resource, mismatchId, scope.permissions[0]!),
    ).toBe(false);
  });

  it.each(cases)('$label — wildcard id grants any specific id', ({ scope, matchId }) => {
    const wildcardScope: ApiKeyScope = { ...scope, id: '*' };
    expect(
      scopeMatches([wildcardScope], scope.resource, matchId, scope.permissions[0]!),
    ).toBe(true);
  });

  it('chat resource — wrong permission is rejected', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'chat', id: 'site_kiosk', permissions: ['read'] },
    ];
    expect(scopeMatches(scopes, 'chat', 'site_kiosk', 'write')).toBe(false);
  });

  it('process resource — admin permission grants admin scope', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'process', id: '*', permissions: ['admin'] },
    ];
    expect(scopeMatches(scopes, 'process', 'mach_anything', 'admin')).toBe(true);
  });

  it('cross-resource — a `chat=site_x:write` scope does NOT grant `deploy=site_x:write`', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'chat', id: 'site_x', permissions: ['write'] },
    ];
    expect(scopeMatches(scopes, 'deploy', 'site_x', 'write')).toBe(false);
  });

  it('multi-scope key — picks the right scope by (resource, id) tuple', () => {
    const scopes: ApiKeyScope[] = [
      { resource: 'chat', id: 'site_a', permissions: ['read'] },
      { resource: 'process', id: 'mach_1', permissions: ['write'] },
      { resource: 'user', id: '*', permissions: ['admin'] },
    ];
    expect(scopeMatches(scopes, 'chat', 'site_a', 'read')).toBe(true);
    expect(scopeMatches(scopes, 'chat', 'site_a', 'write')).toBe(false);
    expect(scopeMatches(scopes, 'process', 'mach_1', 'write')).toBe(true);
    expect(scopeMatches(scopes, 'process', 'mach_2', 'write')).toBe(false);
    expect(scopeMatches(scopes, 'user', 'uid_anyone', 'admin')).toBe(true);
  });
});

describe('scopeMatches — empty scopes array always rejects', () => {
  it.each(ALL_RESOURCES)('rejects %s with empty scope list', (resource) => {
    expect(scopeMatches([], resource, 'anything', 'read')).toBe(false);
  });
});
