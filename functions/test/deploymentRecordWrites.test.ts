/**
 * The deployment record's two server-side writers, the result reconciler
 * (deploymentStatus.ts) and the stale-target sweeper (deploymentSweeper.ts),
 * against an in-memory firestore whose transactions retry when a document they
 * read was written before they commit, as firestore's do.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { updateDeployment } from '../src/deploymentStatus';
import { sweepDeployment } from '../src/deploymentSweeper';

type Doc = Record<string, unknown>;
type Write = (path: string, payload: Doc) => void;

const DEPLOYMENT = 'sites/s1/deployments/d1';
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

function fakeDb(initial: Record<string, Doc>, onRead?: (path: string, write: Write) => void) {
  const docs = new Map<string, Doc>(Object.entries(initial));
  const versions = new Map<string, number>();
  const write: Write = (path, payload) => {
    docs.set(path, { ...(docs.get(path) ?? {}), ...payload });
    versions.set(path, (versions.get(path) ?? 0) + 1);
  };
  const read = async (path: string) => {
    const data = docs.get(path);
    onRead?.(path, write);
    return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
  };
  const ref = (path: string) => ({
    path,
    get: () => read(path),
    update: async (payload: Doc) => write(path, payload),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string) => ({ doc: (id: string) => ref(`${path}/${id}`) });

  async function runTransaction<T>(
    fn: (tx: { get: (r: { path: string }) => unknown; update: (r: { path: string }, p: Doc) => void }) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = new Map<string, number>();
      const writes: Array<[string, Doc]> = [];
      const result = await fn({
        get: (r) => {
          seen.set(r.path, versions.get(r.path) ?? 0);
          return read(r.path);
        },
        update: (r, payload) => {
          writes.push([r.path, payload]);
        },
      });
      if ([...seen].every(([path, version]) => (versions.get(path) ?? 0) === version)) {
        writes.forEach(([path, payload]) => write(path, payload));
        return result;
      }
    }
    throw new Error('transaction kept conflicting');
  }

  return {
    db: { collection, runTransaction } as unknown as Firestore,
    ref: (path: string) => ref(path) as unknown as DocumentReference,
    doc: (path: string) => docs.get(path) as { status: string; targets: Array<{ machineId: string; status: string }> },
  };
}

function result(cmdId: string, status: string, type: string) {
  return [{ cmdId, cmdData: { status, type, deployment_id: 'd1' } }];
}

describe('updateDeployment', () => {
  it('two machines reporting on one deployment at once both land', async () => {
    const { db, doc } = fakeDb({
      [DEPLOYMENT]: {
        status: 'in_progress',
        targets: [
          { machineId: 'm1', status: 'installing' },
          { machineId: 'm2', status: 'installing' },
        ],
      },
    });

    await Promise.all([
      updateDeployment(db, 's1', 'm1', 'd1', result('c1', 'completed', 'install_software')),
      updateDeployment(db, 's1', 'm2', 'd1', result('c2', 'completed', 'install_software')),
    ]);

    assert.deepEqual(doc(DEPLOYMENT).targets.map((t) => t.status), ['completed', 'completed']);
    assert.equal(doc(DEPLOYMENT).status, 'completed');
  });

  it('two kiosks finishing one uninstall together take the record to uninstalled', async () => {
    const { db, doc } = fakeDb({
      [DEPLOYMENT]: {
        status: 'completed',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'completed' },
        ],
      },
    });

    await Promise.all([
      updateDeployment(db, 's1', 'm1', 'd1', result('u1', 'completed', 'uninstall_software')),
      updateDeployment(db, 's1', 'm2', 'd1', result('u2', 'completed', 'uninstall_software')),
    ]);

    assert.deepEqual(doc(DEPLOYMENT).targets.map((t) => t.status), ['uninstalled', 'uninstalled']);
    assert.equal(doc(DEPLOYMENT).status, 'uninstalled');
  });
});

describe('sweepDeployment', () => {
  it('does not fail a target whose result landed while the sweep ran', async () => {
    let reported = false;
    const { db, ref, doc } = fakeDb(
      {
        [DEPLOYMENT]: {
          status: 'in_progress',
          createdAt: NOW - 60 * MINUTE,
          targets: [
            { machineId: 'm1', status: 'installing' },
            { machineId: 'm2', status: 'installing' },
          ],
        },
      },
      (path, write) => {
        // m2's agent reports right after the sweep has read the record.
        if (path !== DEPLOYMENT || reported) return;
        reported = true;
        write(DEPLOYMENT, {
          targets: [
            { machineId: 'm1', status: 'installing' },
            { machineId: 'm2', status: 'completed' },
          ],
        });
      },
    );

    const status = await sweepDeployment(db, ref(DEPLOYMENT), NOW);

    assert.deepEqual(doc(DEPLOYMENT).targets.map((t) => t.status), ['failed', 'completed']);
    assert.equal(status, 'partial');
  });
});
