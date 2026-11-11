/**
 * The sweeper's stale-target timeouts: pending fails after 15 minutes, active after 30.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { timeOutStaleTargets, type DeploymentTarget } from '../src/lib/deploymentUtils';

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const FAILED_AT = NOW;

describe('timeOutStaleTargets', () => {
  it('fails a target still pending 15 minutes after the deployment was created', () => {
    const out = timeOutStaleTargets(
      [{ machineId: 'm1', status: 'pending' }],
      NOW - 16 * MINUTE,
      NOW,
      FAILED_AT,
    );
    assert.equal(out?.[0].status, 'failed');
    assert.equal(out?.[0].completedAt, FAILED_AT);
  });

  it('fails a target still installing 30 minutes after the deployment was created', () => {
    const out = timeOutStaleTargets(
      [{ machineId: 'm1', status: 'installing' }],
      NOW - 31 * MINUTE,
      NOW,
      FAILED_AT,
    );
    assert.equal(out?.[0].status, 'failed');
  });

  it('returns null when nothing has timed out, and never touches a terminal target', () => {
    const out = timeOutStaleTargets(
      [
        { machineId: 'm1', status: 'pending' },
        { machineId: 'm2', status: 'completed' },
      ],
      NOW - 5 * MINUTE,
      NOW,
      FAILED_AT,
    );
    assert.equal(out, null);
  });

  it('times a retried target from its retry, not from the deployment', () => {
    // the retry route resets a failed target to pending and stamps retriedAt; an old
    // deployment's retry must get the full 15 minutes, not fail at the next sweep
    const targets: DeploymentTarget[] = [
      { machineId: 'm1', status: 'pending', retriedAt: Timestamp.fromMillis(NOW - 1 * MINUTE) },
      { machineId: 'm2', status: 'downloading', retriedAt: NOW - 10 * MINUTE },
    ];
    const out = timeOutStaleTargets(targets, NOW - 120 * MINUTE, NOW, FAILED_AT);
    assert.equal(out, null);
  });

  it('still fails a retried target once its own timeout has passed', () => {
    const out = timeOutStaleTargets(
      [{ machineId: 'm1', status: 'pending', retriedAt: NOW - 16 * MINUTE }],
      NOW - 120 * MINUTE,
      NOW,
      FAILED_AT,
    );
    assert.equal(out?.[0].status, 'failed');
  });
});
