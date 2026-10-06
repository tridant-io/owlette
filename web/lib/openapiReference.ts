type JsonRecord = Record<string, unknown>;

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

const DEFAULT_SECURITY = [
  { apiKey: [] },
  { bearerApiKey: [] },
  { firebaseIdToken: [] },
];

const REFERENCE_DESCRIPTION = `the owlette API manages sites, machines, processes, installer deployments, roost content and versions, hoot conversations, quotas, audit logs and webhooks.

## authentication

send a scoped API key as \`Authorization: Bearer owk_live_...\` (preferred) or in the \`x-api-key\` header. dashboard and first-party flows may use Firebase ID tokens. see [/docs/api/authentication](/docs/api/authentication).

every protected operation below has an **Authentication and scopes** note. when it lists several scopes the key needs all of them, and the call must also pass site membership, role and capability checks. swoop sessions refuse API keys outright.

## versioning

there is no global API-version header. roost routes accept the advisory \`Roost-Version: YYYY-MM-DD\` header, and a request without it may get \`X-Roost-Version-Missing: true\` back. see [/docs/api/versions](/docs/api/versions).

## errors

errors use \`application/problem+json\` with a stable \`code\`, a \`requestId\` and a \`docsUrl\` that links to the code's entry in [/docs/api/errors](/docs/api/errors).

## pagination

list endpoints take \`page_size\` and \`page_token\` (\`limit\` and \`cursor\` are accepted as aliases) and return \`next_page_token\`. defaults and maximums vary by route: see [/docs/api/pagination](/docs/api/pagination).

## idempotency

some mutating endpoints require \`Idempotency-Key\`, others accept it, and a replay is scoped to the same caller, method, path, query and body. [/docs/api/idempotency](/docs/api/idempotency) lists which is which.

## rate limits

limited routes send \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\` and, on a refusal, \`Retry-After\`. API-key traffic is bucketed by key. see [/docs/api/rate-limits](/docs/api/rate-limits).

## models

the **Models** section at the end documents the object shapes the API is built from: \`Site\`, \`Machine\`, \`Process\`, \`HootConversation\` and the rest. they are definitions, not endpoints: every operation that returns a machine returns the \`Machine\` shape.`;

export interface OpenApiOperation {
  path: string;
  method: string;
  operation: JsonRecord;
}

interface AuthScopeNotes {
  auth: string;
  scope: string;
  scopes: string[];
}

export function renderOpenApiReference(rawSpec: JsonRecord): JsonRecord {
  const spec = cloneRecord(rawSpec);
  const info = ensureRecord(spec, 'info');
  lowercaseOpenApiDisplayLabels(spec);
  info.description = REFERENCE_DESCRIPTION;

  const externalDocs = ensureRecord(spec, 'externalDocs');
  externalDocs.description = 'Owlette public API guide';
  externalDocs.url = 'https://owlette.app/docs/api';
  normalizeMarkdownLinks(spec);

  const paths = asRecord(spec.paths);
  if (!paths) return spec;

  for (const { path, method, operation } of getOpenApiOperations(spec)) {
    if (!Array.isArray(operation.security) && path !== '/api/version') {
      operation.security = cloneValue(DEFAULT_SECURITY);
    }

    const notes = inferAuthScopeNotes(path, method, operation);
    operation['x-required-scopes'] = notes.scopes;
    operation['x-auth-note'] = notes.auth;
    operation['x-scope-note'] = notes.scope;
    operation.description = withAuthScopeSection(operation.description, notes);

    addRequestBodyExample(spec, operation);
    addResponseExamples(spec, operation);
    addCodeSample(spec, path, method, operation, notes);
  }

  return spec;
}

function lowercaseOpenApiDisplayLabels(spec: JsonRecord): void {
  const tagNameMap = new Map<string, string>();
  const lowerDisplayLabel = (value: string): string => value.toLowerCase();
  const lowerTagName = (value: string): string => {
    const existing = tagNameMap.get(value);
    if (existing) return existing;
    const lowercased = lowerDisplayLabel(value);
    tagNameMap.set(value, lowercased);
    return lowercased;
  };

  const info = asRecord(spec.info);
  if (typeof info?.title === 'string') {
    info.title = lowerDisplayLabel(info.title);
  }

  if (Array.isArray(spec.tags)) {
    for (const tag of spec.tags) {
      const tagRecord = asRecord(tag);
      if (typeof tagRecord?.name === 'string') {
        tagRecord.name = lowerTagName(tagRecord.name);
      }
    }
  }

  const tagGroups = spec['x-tagGroups'];
  if (Array.isArray(tagGroups)) {
    for (const group of tagGroups) {
      const groupRecord = asRecord(group);
      if (!groupRecord) continue;
      if (typeof groupRecord.name === 'string') {
        groupRecord.name = lowerDisplayLabel(groupRecord.name);
      }
      if (Array.isArray(groupRecord.tags)) {
        groupRecord.tags = groupRecord.tags.map((tag) => (
          typeof tag === 'string' ? lowerTagName(tag) : tag
        ));
      }
    }
  }

  for (const { operation } of getOpenApiOperations(spec)) {
    if (Array.isArray(operation.tags)) {
      operation.tags = operation.tags.map((tag) => (
        typeof tag === 'string' ? lowerTagName(tag) : tag
      ));
    }
    if (typeof operation.summary === 'string') {
      operation.summary = lowerDisplayLabel(operation.summary);
    }
  }
}

export function getOpenApiOperations(spec: JsonRecord): OpenApiOperation[] {
  const paths = asRecord(spec.paths);
  if (!paths) return [];

  const operations: OpenApiOperation[] = [];
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemValue);
    if (!pathItem) continue;

    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = asRecord(operationValue);
      if (!operation) continue;
      operations.push({ path, method, operation });
    }
  }

  return operations;
}

export function operationHasExplicitSecurity(operation: JsonRecord): boolean {
  return Array.isArray(operation.security);
}

export function operationHasReferenceExample(operation: JsonRecord): boolean {
  return operationHasCodeSample(operation) && (
    !operationNeedsMediaExample(operation) || operationHasMediaExample(operation)
  );
}

export function operationHasCodeSample(operation: JsonRecord): boolean {
  return hasCodeSample(operation);
}

export function operationHasMediaExample(operation: JsonRecord): boolean {
  return operation['x-has-media-examples'] === true ||
    deepHasExample(operation.requestBody) ||
    deepHasExample(operation.responses);
}

export function operationNeedsMediaExample(operation: JsonRecord): boolean {
  return operation['x-has-reference-media'] === true;
}

export function operationHasAuthScopeNote(operation: JsonRecord): boolean {
  const scopes = operation['x-required-scopes'];
  const hasScopes = Array.isArray(scopes) && scopes.length > 0;
  const description = typeof operation.description === 'string' ? operation.description : '';
  return hasScopes && description.includes('### Authentication and scopes');
}

function inferAuthScopeNotes(path: string, method: string, operation: JsonRecord): AuthScopeNotes {
  const security = operation.security;
  if (Array.isArray(security) && security.length === 0) {
    return {
      auth: 'No authentication required.',
      scope: 'No API-key scope required.',
      scopes: ['public'],
    };
  }

  const permission = inferPermission(path, method);

  if (operationUsesOnlyFirebaseSecurity(operation)) {
    return {
      auth: 'Requires a signed-in user session or Firebase ID token. API keys cannot call this operation.',
      scope: 'No API-key scope applies; access is controlled by the user session, Firebase token, role, and route-specific authorization checks.',
      scopes: ['session-or-firebase'],
    };
  }

  if (path.startsWith('/api/account/api-keys')) {
    return protectedNotes(['user=*:admin'], 'Requires superadmin account access. Scoped API-key callers keep their existing scope ceiling.');
  }

  if (path.startsWith('/api/platform')) {
    return protectedNotes(['user=*:admin'], 'Requires a superadmin platform role.');
  }

  if (path.startsWith('/api/installer')) {
    return protectedNotes([`installer=*:${permission}`], 'Requires superadmin installer access.');
  }

  if (path.startsWith('/api/users')) {
    return protectedNotes([`user=*:${permission === 'read' ? 'read' : 'admin'}`], 'Requires superadmin user-management access.');
  }

  if (path.startsWith('/api/cli/device-code')) {
    return protectedNotes(['device-code:pairing'], 'Device-code creation and polling are public pairing steps; authorization requires an authenticated user session.');
  }

  // `/api/cortex` is the deprecated back-compat alias of `/api/hoot`; both are
  // documented, so both need the same scope note.
  if (path.startsWith('/api/hoot') || path.startsWith('/api/cortex')) {
    return protectedNotes([`chat=<siteId>:${permission}`], 'API-key Hoot access is site-scoped; write access can send messages but server-side tools remain capability limited.');
  }

  if (path.startsWith('/api/webhooks') || path.startsWith('/api/events/stream')) {
    return protectedNotes([`site=<siteId>:${permission}`], 'Webhook and event-stream access is scoped to the target site.');
  }

  if (path.startsWith('/api/chunks')) {
    return protectedNotes([`roost=<roostId>:${permission}`], 'Chunk operations are authorized through the Roost/site context supplied by the request.');
  }

  if (path.startsWith('/api/roosts')) {
    const roostPermission = inferRoostPermission(path, method);
    return protectedNotes([`roost=<roostId>:${roostPermission}`], 'Roost access is scoped to the addressed Roost and its owning site.');
  }

  if (path.includes('/machines/{machineId}/commands') || path.includes('/machines/{machineId}/processes') || path.includes('/machines/{machineId}/screenshots') || path.includes('/machines/{machineId}/display-layout') || path.includes('/machines/{machineId}/reboot-schedule') || path.includes('/machines/{machineId}/uninstall')) {
    return protectedNotes([`machine=<machineId>:${permission}`], 'Machine operations are also constrained by site membership and machine capability checks.');
  }

  if (path.includes('/sites/{siteId}/deployments')) {
    return protectedNotes([`site=<siteId>:${permission}`], 'Site-scoped deployment operations require access to the owning site.');
  }

  if (path.startsWith('/api/sites/{siteId}')) {
    return protectedNotes([`site=<siteId>:${permission}`], 'Site-scoped operations require access to the addressed site.');
  }

  if (path === '/api/sites') {
    if (method.toLowerCase() === 'get') {
      return protectedNotes(['site=*:read'], 'Scoped API keys see only sites granted by their site scopes.');
    }
    return protectedNotes(['site=*:admin'], 'Creating a site needs a key with `site=*:admin`.');
  }

  if (path === '/api/whoami') {
    return protectedNotes(['any-valid-credential'], 'Echoes the resolved identity and scopes for any valid supported credential.');
  }

  return protectedNotes([`${permission}-scope-required`], 'See this operation description and security schemes for the exact resource scope.');
}

function protectedNotes(scopes: string[], scope: string): AuthScopeNotes {
  return {
    auth: 'Send a scoped API key as `Authorization: Bearer $OWLETTE_API_KEY`; compatible routes may also accept `x-api-key`, `api_key`, or first-party Firebase/session credentials.',
    scope,
    scopes,
  };
}

function operationUsesOnlyFirebaseSecurity(operation: JsonRecord): boolean {
  const security = Array.isArray(operation.security) ? operation.security : [];
  return security.length > 0 && security.every((entry) => {
    const record = asRecord(entry);
    return !!record && Object.keys(record).length === 1 && Array.isArray(record.firebaseIdToken);
  });
}

function inferPermission(path: string, method: string): string {
  const normalized = method.toLowerCase();
  if (normalized === 'get' || normalized === 'head' || normalized === 'options') return 'read';
  if (path.endsWith('/rollback')) return 'rollback';
  if (path.endsWith('/deploy') || path.endsWith('/resync')) return 'deploy';
  if (normalized === 'delete' && path.startsWith('/api/installer')) return 'admin';
  return 'write';
}

function inferRoostPermission(path: string, method: string): string {
  if (path.endsWith('/rollback')) return 'rollback';
  if (path.endsWith('/deploy') || path.endsWith('/resync')) return 'deploy';
  return inferPermission(path, method);
}

function withAuthScopeSection(descriptionValue: unknown, notes: AuthScopeNotes): string {
  const description = typeof descriptionValue === 'string' && descriptionValue.trim()
    ? descriptionValue.trim()
    : 'Public API operation.';

  if (description.includes('### Authentication and scopes')) {
    return description;
  }

  return `${description}\n\n### Authentication and scopes\n\n${notes.auth}\n\nRequired scope: ${notes.scope}`;
}

function addRequestBodyExample(spec: JsonRecord, operation: JsonRecord): void {
  const requestBody = asRecord(resolveMaybeRef(spec, operation.requestBody));
  const content = asRecord(requestBody?.content);
  if (!content) return;

  const media = asRecord(content['application/json']);
  if (!media) return;
  operation['x-has-reference-media'] = true;
  if (hasOwnExample(media)) {
    operation['x-has-media-examples'] = true;
    return;
  }

  const example = exampleFromSchema(spec, media.schema, 'request');
  if (example !== undefined) {
    media.example = example;
    operation['x-has-media-examples'] = true;
  }
}

function addResponseExamples(spec: JsonRecord, operation: JsonRecord): void {
  const responses = asRecord(operation.responses);
  if (!responses) return;

  for (const responseValue of Object.values(responses)) {
    const response = asRecord(resolveMaybeRef(spec, responseValue));
    const content = asRecord(response?.content);
    if (!content) continue;

    for (const [mediaType, mediaValue] of Object.entries(content)) {
      const media = asRecord(mediaValue);
      if (!media) continue;
      operation['x-has-reference-media'] = true;
      if (hasOwnExample(media)) {
        operation['x-has-media-examples'] = true;
        continue;
      }

      if (mediaType.includes('json')) {
        media.example = exampleFromSchema(spec, media.schema, 'response') ?? {};
        operation['x-has-media-examples'] = true;
      } else if (mediaType === 'text/event-stream') {
        media.example = 'event: connected\ndata: {"ok":true}\n\n';
        operation['x-has-media-examples'] = true;
      } else if (mediaType.startsWith('text/')) {
        media.example = 'ok';
        operation['x-has-media-examples'] = true;
      }
    }
  }
}

function addCodeSample(spec: JsonRecord, path: string, method: string, operation: JsonRecord, notes: AuthScopeNotes): void {
  if (hasCodeSample(operation)) return;

  const lines = [`curl -X ${method.toUpperCase()} "https://owlette.app${pathForCurl(path)}"`];
  if (notes.scopes.includes('session-or-firebase')) {
    lines.push('  -H "Authorization: Bearer $FIREBASE_ID_TOKEN"');
  } else if (!notes.scopes.includes('public')) {
    lines.push('  -H "Authorization: Bearer $OWLETTE_API_KEY"');
  }

  const requestBody = asRecord(resolveMaybeRef(spec, operation.requestBody));
  const content = asRecord(requestBody?.content);
  const jsonMedia = asRecord(content?.['application/json']);
  if (jsonMedia) {
    lines.push('  -H "Content-Type: application/json"');
    if (operationRequiresIdempotency(operation)) {
      lines.push('  -H "Idempotency-Key: $OWLETTE_IDEMPOTENCY_KEY"');
    }
    const example = jsonMedia.example ?? exampleFromSchema(spec, jsonMedia.schema, 'request') ?? {};
    lines.push(`  -d '${JSON.stringify(example, null, 2)}'`);
  } else if (operationRequiresIdempotency(operation)) {
    lines.push('  -H "Idempotency-Key: $OWLETTE_IDEMPOTENCY_KEY"');
  }

  operation['x-codeSamples'] = [
    {
      lang: 'Shell',
      label: 'curl',
      source: lines.join(' \\\n'),
    },
  ];
}

function pathForCurl(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => `$${shellVariableName(name)}`);
}

function shellVariableName(name: string): string {
  if (name === 'uid') return 'USER_ID';
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

function normalizeMarkdownLinks(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeMarkdownLinks(item);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      record[key] = child
        .replace(/\.\.\/docs\/api\/([a-z0-9-]+)\.md(#[A-Za-z0-9_-]+)?/g, (_match, slug: string, hash = '') => `/docs/api/${slug}${hash}`)
        .replace(/\.\.\/docs\/internal\/([a-z0-9-]+)\.md(#[A-Za-z0-9_-]+)?/g, (_match, slug: string, hash = '') => `/docs/internal/${slug}${hash}`);
    } else {
      normalizeMarkdownLinks(child);
    }
  }
}

function operationRequiresIdempotency(operation: JsonRecord): boolean {
  const description = typeof operation.description === 'string' ? operation.description : '';
  if (/Idempotency-Key/i.test(description)) return true;

  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  return parameters.some((parameter) => {
    const record = asRecord(parameter);
    return typeof record?.name === 'string' && record.name.toLowerCase() === 'idempotency-key';
  });
}

function exampleFromSchema(spec: JsonRecord, schemaValue: unknown, hint: string, seen = new Set<string>()): unknown {
  const schema = asRecord(resolveMaybeRef(spec, schemaValue, seen));
  if (!schema) return undefined;

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  const oneOf = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    return exampleFromSchema(spec, oneOf[0], hint, seen);
  }

  if (Array.isArray(schema.allOf)) {
    const merged: JsonRecord = {};
    for (const part of schema.allOf) {
      const example = exampleFromSchema(spec, part, hint, seen);
      if (isPlainObject(example)) Object.assign(merged, example);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
  const properties = asRecord(schema.properties);

  if (type === 'object' || properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
    const keys = properties
      ? Object.keys(properties).filter((key) => required.has(key)).concat(Object.keys(properties).filter((key) => !required.has(key)).slice(0, 4))
      : [];
    const example: JsonRecord = {};
    for (const key of keys) {
      example[key] = exampleFromSchema(spec, properties?.[key], key, seen) ?? fallbackScalarExample(key);
    }
    if (Object.keys(example).length > 0) return example;
    if (schema.additionalProperties) return { key: 'value' };
    return {};
  }

  if (type === 'array') {
    return [exampleFromSchema(spec, schema.items, hint, seen) ?? fallbackScalarExample(hint)];
  }

  if (type === 'integer' || type === 'number') return numericExample(hint);
  if (type === 'boolean') return true;
  if (type === 'string') {
    const format = typeof schema.format === 'string' ? schema.format : '';
    if (format === 'date-time') return '2026-04-28T12:00:00Z';
    if (format === 'date') return '2026-04-28';
    if (format === 'uri') return 'https://example.com/webhook';
    if (format === 'email') return 'developer@example.com';
    return fallbackScalarExample(hint);
  }

  return fallbackScalarExample(hint);
}

function numericExample(hint: string): number {
  if (/size|limit|count|bytes|total|remaining/i.test(hint)) return 100;
  if (/percent|ratio/i.test(hint)) return 0.5;
  return 1;
}

function fallbackScalarExample(hint: string): string {
  if (/site/i.test(hint)) return 'site_123';
  if (/machine/i.test(hint)) return 'machine_123';
  if (/roost/i.test(hint)) return 'roost_123';
  if (/version/i.test(hint)) return 'vrs_123';
  if (/deployment|rollout/i.test(hint)) return 'dep_123';
  if (/command/i.test(hint)) return 'cmd_123';
  if (/key/i.test(hint)) return 'key_123';
  if (/url|uri/i.test(hint)) return 'https://example.com/webhook';
  if (/hash|digest|checksum/i.test(hint)) return '4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce';
  if (/email/i.test(hint)) return 'developer@example.com';
  if (/date/i.test(hint)) return '2026-04-28T12:00:00Z';
  return 'string';
}

function resolveMaybeRef(spec: JsonRecord, value: unknown, seen = new Set<string>()): unknown {
  const record = asRecord(value);
  const ref = typeof record?.$ref === 'string' ? record.$ref : '';
  if (!ref.startsWith('#/') || seen.has(ref)) return value;

  seen.add(ref);
  const resolved = ref.slice(2).split('/').reduce<unknown>((current, part) => {
    const currentRecord = asRecord(current);
    return currentRecord?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, spec);

  return resolved ?? value;
}

function hasOwnExample(record: JsonRecord): boolean {
  return record.example !== undefined || record.examples !== undefined;
}

function deepHasExample(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (hasOwnExample(value as JsonRecord)) return true;
  if (Array.isArray(value)) return value.some(deepHasExample);
  return Object.values(value as JsonRecord).some(deepHasExample);
}

function hasCodeSample(operation: JsonRecord): boolean {
  const samples = operation['x-codeSamples'];
  return Array.isArray(samples) && samples.some((sample) => {
    const record = asRecord(sample);
    return typeof record?.source === 'string' && record.source.trim().length > 0;
  });
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const next: JsonRecord = {};
  parent[key] = next;
  return next;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
