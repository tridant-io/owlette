/** @jest-environment node */
/**
 * `machineStatus`: the one mapping of a machine document both machines listings
 * share (`GET /api/sites/{siteId}/machines` and `GET /api/sites?include=machines`).
 * the name, version and heartbeat fall back to the older fields, and the state is
 * `machineOnlineState`'s, so a flag stuck online with a stale heartbeat reads offline.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { MACHINE_STATUS_FIELDS, machineStatus } from '@/lib/machineStatus.server';

const NOW_SEC = 1_800_000_000;
const fresh = Timestamp.fromMillis((NOW_SEC - 30) * 1000);
const stale = Timestamp.fromMillis((NOW_SEC - 18 * 24 * 60 * 60) * 1000);

it('reads a live machine as online, with its name, version and heartbeat', () => {
  expect(
    machineStatus('m1', { name: 'GALLERY-WALL-01', online: true, lastHeartbeat: fresh, agent_version: '4.2.7' }, NOW_SEC),
  ).toEqual({
    id: 'm1',
    name: 'GALLERY-WALL-01',
    online: true,
    asleep: false,
    lastHeartbeat: fresh.toDate().toISOString(),
    agentVersion: '4.2.7',
  });
});

it('reads a flag stuck online behind an 18-day-old heartbeat as offline', () => {
  expect(machineStatus('m1', { online: true, lastHeartbeat: stale }, NOW_SEC)).toMatchObject({
    online: false,
    asleep: false,
    lastHeartbeat: stale.toDate().toISOString(),
  });
});

it('reads a machine its agent marked asleep as asleep, not online', () => {
  expect(machineStatus('m1', { online: true, asleep: true, lastHeartbeat: fresh }, NOW_SEC)).toMatchObject({
    online: false,
    asleep: true,
  });
});

it('reads asleep as offline once the agent wrote online false', () => {
  expect(machineStatus('m1', { online: false, asleep: true, lastHeartbeat: fresh }, NOW_SEC)).toMatchObject({
    online: false,
    asleep: false,
  });
});

it('falls back to machine_name, then the id, and to the presence heartbeat and version', () => {
  expect(
    machineStatus(
      'm1',
      { machine_name: 'OLD-NAME', online: true, presence: { lastHeartbeat: fresh, agent_version: '3.3.7' } },
      NOW_SEC,
    ),
  ).toMatchObject({ name: 'OLD-NAME', online: true, agentVersion: '3.3.7', lastHeartbeat: fresh.toDate().toISOString() });
  expect(machineStatus('m1', {}, NOW_SEC)).toEqual({
    id: 'm1',
    name: 'm1',
    online: false,
    asleep: false,
    lastHeartbeat: null,
    agentVersion: null,
  });
});

it('selects every field it reads, the fallbacks included', () => {
  expect([...MACHINE_STATUS_FIELDS].sort()).toEqual(
    [
      'name',
      'machine_name',
      'online',
      'asleep',
      'lastHeartbeat',
      'agent_version',
      'presence.lastHeartbeat',
      'presence.agent_version',
    ].sort(),
  );
});
