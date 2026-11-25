/**
 * POST /api/agent/hoot/key — hands a machine the LLM key that
 * `/api/hoot/provision-key` queued for it, once.
 *
 * body: `{ siteId, machineId, keyId }`, `keyId` being the command's `key_id`.
 * auth: the machine's own agent token, whose `site_id` and `machine_id` claims
 * must match the body. the key is held under that machine, so another
 * machine's id finds nothing; every refusal is the same 404.
 *
 * 200 `{ apiKey }`, never cached. the stored copy is deleted on read, and
 * nothing here is logged.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { problemNotFound, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import { resolveAgentPrincipal } from '@/lib/sitePolicy.server';
import { withRateLimit } from '@/lib/withRateLimit';

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const POST = withRateLimit(
  async (request: NextRequest): Promise<NextResponse> => {
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return problemValidation('request body is not valid json');
      }
      const { siteId, machineId, keyId } = (body ?? {}) as Record<string, unknown>;
      if (
        typeof siteId !== 'string' ||
        typeof machineId !== 'string' ||
        typeof keyId !== 'string' ||
        !KEY_ID_PATTERN.test(keyId)
      ) {
        return problemValidation('siteId, machineId and keyId are required');
      }

      const agent = await resolveAgentPrincipal(request, siteId, machineId);
      if (agent?.matched !== true) return problemNotFound('site not found or no access');

      const keyRef = getAdminDb()
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .collection('hoot_key_handoffs')
        .doc(keyId);
      const encrypted = (await keyRef.get()).data()?.apiKeyEncrypted;
      if (typeof encrypted !== 'string') return problemNotFound('key not found');

      await keyRef.delete();
      return NextResponse.json(
        { apiKey: decryptApiKey(encrypted) },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error: unknown) {
      return apiError(error, 'agent/hoot/key');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
