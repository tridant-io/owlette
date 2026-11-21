/**
 * A `deployment_failed` site log row keeps the url an agent failed to download
 * from, minus its query string, the way the agent's redact_query_strings cuts it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentReference } from 'firebase-admin/firestore';
import { redactDeploymentLog } from '../src/deploymentLogRedaction';

function fakeRef() {
  const updates: Array<Record<string, unknown>> = [];
  const ref = {
    update: async (patch: Record<string, unknown>) => {
      updates.push(patch);
    },
  } as unknown as Pick<DocumentReference, 'update'>;
  return { ref, updates };
}

const SIGNED = 'https://storage.example.com/b/setup.exe?X-Goog-Algorithm=GOOG4&X-Goog-Signature=abc123';

describe('redactDeploymentLog', () => {
  it("cuts the query string from a failed download's url and keeps the host and path", async () => {
    const { ref, updates } = fakeRef();

    await redactDeploymentLog(
      {
        action: 'deployment_failed',
        details: `Deployment deploy-1 failed: Error: Failed to download installer from ${SIGNED}`,
      },
      ref,
    );

    assert.deepEqual(updates, [
      {
        details:
          'Deployment deploy-1 failed: Error: Failed to download installer from https://storage.example.com/b/setup.exe?<redacted>',
      },
    ]);
  });

  it('cuts every query string in the details, as the agent does', async () => {
    const { ref, updates } = fakeRef();

    await redactDeploymentLog(
      {
        action: 'deployment_failed',
        details: `Deployment deploy-1 failed: Failed to download installer after 3 retries from ${SIGNED} ('${SIGNED}')`,
      },
      ref,
    );

    assert.equal(
      updates[0]?.details,
      "Deployment deploy-1 failed: Failed to download installer after 3 retries from https://storage.example.com/b/setup.exe?<redacted> ('https://storage.example.com/b/setup.exe?<redacted>')",
    );
  });

  it('writes nothing when the details carry no query string', async () => {
    const { ref, updates } = fakeRef();

    await redactDeploymentLog(
      { action: 'deployment_failed', details: 'Deployment deploy-1 failed: Error: exit code 1603' },
      ref,
    );

    assert.deepEqual(updates, []);
  });

  it('leaves every other action alone', async () => {
    const { ref, updates } = fakeRef();

    await redactDeploymentLog({ action: 'deployment_completed', details: `Deployment deploy-1: ${SIGNED}` }, ref);
    await redactDeploymentLog({ action: 'process_crash', details: `crashed opening ${SIGNED}` }, ref);

    assert.deepEqual(updates, []);
  });

  it('leaves a row without string details alone', async () => {
    const { ref, updates } = fakeRef();

    await redactDeploymentLog({ action: 'deployment_failed', details: { url: SIGNED } }, ref);
    await redactDeploymentLog(undefined, ref);

    assert.deepEqual(updates, []);
  });
});
