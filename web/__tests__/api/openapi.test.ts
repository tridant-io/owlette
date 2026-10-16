/** @jest-environment node */

import { GET } from '@/app/api/openapi/route';
import {
  getOpenApiOperations,
  operationHasAuthScopeNote,
  operationHasCodeSample,
  operationHasExplicitSecurity,
  operationHasMediaExample,
  operationHasReferenceExample,
  operationNeedsMediaExample,
} from '@/lib/openapiReference';

function findOperation(spec: Record<string, unknown>, method: string, path: string) {
  return getOpenApiOperations(spec).find(
    (operation) => operation.method === method && operation.path === path,
  )?.operation;
}

describe('/api/openapi', () => {
  it('serves the rendered API reference with examples and auth/scope notes', async () => {
    const response = await GET();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toContain('max-age=3600');

    const spec = await response.json() as Record<string, unknown>;
    expect(spec.openapi).toMatch(/^3\./);
    expect((spec.info as { description?: string }).description).toContain('application/problem+json');
    expect((spec.info as { description?: string }).description).toContain('Authorization: Bearer');

    const operations = getOpenApiOperations(spec);
    expect(operations.length).toBeGreaterThan(100);

    const missingSecurity = operations
      .filter(({ operation }) => !operationHasExplicitSecurity(operation))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    const missingExamples = operations
      .filter(({ operation }) => !operationHasReferenceExample(operation))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    const missingCodeSamples = operations
      .filter(({ operation }) => !operationHasCodeSample(operation))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    const missingMediaExamples = operations
      .filter(({ operation }) => operationNeedsMediaExample(operation) && !operationHasMediaExample(operation))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    const missingScopeNotes = operations
      .filter(({ operation }) => !operationHasAuthScopeNote(operation))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);

    expect(missingSecurity).toEqual([]);
    expect(missingExamples).toEqual([]);
    expect(missingCodeSamples).toEqual([]);
    expect(missingMediaExamples).toEqual([]);
    expect(missingScopeNotes).toEqual([]);

    expect(findOperation(spec, 'get', '/api/version')?.security).toEqual([]);
    expect(findOperation(spec, 'post', '/api/sites')?.['x-required-scopes'])
      .toContain('site=*:admin');
    expect(findOperation(spec, 'post', '/api/keys')?.['x-required-scopes'])
      .toContain('session-or-firebase');

    const commandOperation = findOperation(spec, 'post', '/api/sites/{siteId}/machines/{machineId}/commands');
    expect(commandOperation?.['x-required-scopes'])
      .toContain('machine=<machineId>:write');
    const commandSample = (commandOperation?.['x-codeSamples'] as Array<{ source: string }>)[0].source;
    expect(commandSample).toContain('/api/sites/$SITE_ID/machines/$MACHINE_ID/commands');
    expect(commandSample).not.toContain('{siteId}');

    expect(findOperation(spec, 'post', '/api/hoot/conversations')?.['x-required-scopes'])
      .toContain('chat=<siteId>:write');
    expect(findOperation(spec, 'post', '/api/installer/upload')?.['x-required-scopes'])
      .toContain('installer=*:write');

    expect(findOperation(spec, 'get', '/api/admin/issues')?.['x-required-scopes'])
      .toEqual(['issue=*:read']);
    expect(findOperation(spec, 'get', '/api/admin/issues/{id}')?.['x-required-scopes'])
      .toEqual(['issue=*:read']);
    expect(findOperation(spec, 'patch', '/api/admin/issues/{id}')?.['x-required-scopes'])
      .toEqual(['issue=*:write']);
    expect(findOperation(spec, 'get', '/api/admin/issues/{id}/logs')?.['x-required-scopes'])
      .toEqual(['issue=*:read']);
  });
});
