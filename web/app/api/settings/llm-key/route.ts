/**
 * User-level LLM API key management.
 *
 * POST: Store/update encrypted API key
 * PATCH: Change the model, keeping the stored key
 * GET: Check if key exists (never returns the key itself)
 * DELETE: Remove stored API key
 *
 * Both writes audit `user_mutated` on the platform tenant (`llm_key_stored` /
 * `llm_key_removed`), mirroring the passkey add/remove pair. The row records the
 * provider and model only — never the key, its ciphertext, or any fragment of it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { encryptApiKey, isLlmEncryptionConfigured } from '@/lib/llm-encryption.server';
import { type LlmProvider } from '@/lib/llm';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      await assertActiveUser(userId);

      if (!isLlmEncryptionConfigured()) {
        return NextResponse.json(
          { error: 'LLM encryption is not configured on the server' },
          { status: 500 }
        );
      }

      const body = await request.json();
      const { provider, apiKey, model } = body as {
        provider: LlmProvider;
        apiKey: string;
        model?: string;
      };

      if (!provider || !apiKey) {
        return NextResponse.json(
          { error: 'provider and apiKey are required' },
          { status: 400 }
        );
      }

      if (!['anthropic', 'openai'].includes(provider)) {
        return NextResponse.json(
          { error: 'Invalid provider. Must be "anthropic" or "openai"' },
          { status: 400 }
        );
      }

      const db = getAdminDb();
      const encrypted = encryptApiKey(apiKey);

      await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .set(
          {
            provider,
            apiKeyEncrypted: encrypted,
            model: model || null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      // Platform-tenant mutation (siteId = ''); the key itself is deliberately absent.
      emitMutation({
        kind: 'user_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: userId,
        attributes: {
          verb: 'llm_key_stored',
          endpoint: '/api/settings/llm-key',
          method: 'POST',
          provider,
          model: model || null,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return apiError(error, 'settings/llm-key POST', error.status);
      }
      return apiError(error, 'settings/llm-key POST');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

/**
 * The model alone. The stored key stays as it is: a user switching models has
 * nothing to re-enter. A provider change is a new key, so it stays on POST.
 */
export const PATCH = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      await assertActiveUser(userId);

      const { model } = (await request.json()) as { model?: unknown };
      if (typeof model !== 'string' || !model) {
        return NextResponse.json({ error: 'model is required' }, { status: 400 });
      }

      const ref = getAdminDb().collection('users').doc(userId).collection('settings').doc('llm');
      const doc = await ref.get();
      if (!doc.exists) {
        return NextResponse.json(
          { error: 'no api key is stored; save a key first', code: 'no_key' },
          { status: 400 }
        );
      }

      await ref.set({ model, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      emitMutation({
        kind: 'user_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: userId,
        attributes: {
          verb: 'llm_model_changed',
          endpoint: '/api/settings/llm-key',
          method: 'PATCH',
          provider: doc.data()!.provider,
          model,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return apiError(error, 'settings/llm-key PATCH', error.status);
      }
      return apiError(error, 'settings/llm-key PATCH');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      const db = getAdminDb();

      const doc = await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .get();

      if (!doc.exists) {
        return NextResponse.json({ configured: false });
      }

      const data = doc.data()!;
      return NextResponse.json({
        configured: true,
        provider: data.provider,
        model: data.model || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      });
    } catch (error: unknown) {
      return apiError(error, 'settings/llm-key GET');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);

export const DELETE = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSession(request);
      await assertActiveUser(userId);
      const db = getAdminDb();

      await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('llm')
        .delete();

      emitMutation({
        kind: 'user_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: userId,
        attributes: {
          verb: 'llm_key_removed',
          endpoint: '/api/settings/llm-key',
          method: 'DELETE',
        },
      });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return apiError(error, 'settings/llm-key DELETE', error.status);
      }
      return apiError(error, 'settings/llm-key DELETE');
    }
  },
  { strategy: 'auth', identifier: 'ip' }
);
