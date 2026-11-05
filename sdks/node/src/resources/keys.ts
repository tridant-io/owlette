import type { OwletteClient } from '../lib/client';

export type ApiKeyPermission = 'read' | 'write' | 'deploy' | 'rollback' | 'admin';
export type ApiKeyResource =
  | 'roost'
  | 'site'
  | 'machine'
  | 'chat'
  | 'deploy'
  | 'process'
  | 'user'
  | 'installer'
  | 'issue';
export type ApiKeyEnvironment = 'live' | 'test';

export interface ApiKeyScope {
  resource: ApiKeyResource;
  id: string;
  permissions: ApiKeyPermission[];
}

export interface ApiKeyRecord {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  environment: ApiKeyEnvironment | null;
  scopes: ApiKeyScope[] | null;
  expiresAt: number | string | null;
  createdAt?: number | string | Record<string, unknown> | null;
  lastUsedAt: number | string | Record<string, unknown> | null;
  lastUsedIp?: string | null;
  rotatedAt?: number | string | null;
  rotatedFromKeyId?: string | null;
  retiresAt?: number | string | null;
  revokedAt?: number | string | null;
  expired?: boolean;
  retired?: boolean;
}

export class Keys {
  constructor(private readonly client: OwletteClient) {}

  async create(opts: {
    name: string;
    scopes: ApiKeyScope[];
    ttlDays?: number;
    environment?: ApiKeyEnvironment;
  }): Promise<{
    key: string;
    keyId: string;
    name: string;
    environment: ApiKeyEnvironment;
    scopes: ApiKeyScope[];
    expiresAt: number;
    keyPrefix: string;
  }> {
    const res = await this.client.request<{
      success: true;
      key: string;
      keyId: string;
      name: string;
      environment: ApiKeyEnvironment;
      scopes: ApiKeyScope[];
      expiresAt: number;
      keyPrefix: string;
    }>('/api/keys', {
      method: 'POST',
      body: opts,
    });
    return res.data;
  }

  async list(): Promise<ApiKeyRecord[]> {
    const res = await this.client.request<{ success: true; keys: ApiKeyRecord[] }>(
      '/api/keys',
    );
    return res.data.keys;
  }

  async rotate(keyId: string, ttlDays?: number): Promise<{
    key: string;
    keyId: string;
    rotatedFromKeyId: string;
    expiresAt: number;
    previousKey: { keyId: string; retiresAt: number };
  }> {
    const body: Record<string, unknown> = {};
    if (ttlDays !== undefined) body.ttlDays = ttlDays;
    const res = await this.client.request<{
      success: true;
      key: string;
      keyId: string;
      rotatedFromKeyId: string;
      expiresAt: number;
      previousKey: { keyId: string; retiresAt: number };
    }>(`/api/keys/${encodeURIComponent(keyId)}/rotate`, {
      method: 'POST',
      body,
    });
    return res.data;
  }

  /**
   * Edit an existing key's scopes and/or name without reissuing the secret.
   *
   * `scopes` replaces the key's scope list outright — it is not merged with
   * what is already there. Like {@link rotate} and {@link revoke}, this route
   * takes a session or Firebase ID token; an api key cannot edit itself.
   */
  async update(
    keyId: string,
    changes: { name?: string; scopes?: ApiKeyScope[] },
  ): Promise<ApiKeyRecord> {
    const res = await this.client.request<{ success: true; key: ApiKeyRecord }>(
      `/api/keys/${encodeURIComponent(keyId)}`,
      {
        method: 'PATCH',
        body: changes,
      },
    );
    return res.data.key;
  }

  async revoke(keyId: string): Promise<void> {
    await this.client.request<{ success: true }>(`/api/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
    });
  }
}
