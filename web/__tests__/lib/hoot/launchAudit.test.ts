/** @jest-environment node */

import { keyedHash, launchChangesBetween, launchChangesForCall } from '@/lib/hoot/launchAudit.server';

const FINGERPRINT = /^\[hash:[0-9a-f]{16} length:\d+\]$/;

beforeEach(() => {
  process.env.CORTEX_INTERNAL_SECRET = 'test-secret';
});

afterEach(() => {
  delete process.env.CORTEX_INTERNAL_SECRET;
});

describe('with no key to hash with', () => {
  beforeEach(() => {
    delete process.env.CORTEX_INTERNAL_SECRET;
  });

  it('writes no hash at all, rather than one anyone could recompute', () => {
    expect(keyedHash('4821')).toBeNull();
    expect(launchChangesBetween(null, { file_path: '--key 4821' })!.file_path.to).toBe('[length:10]');
  });
});

describe('keyedHash', () => {
  it('is a different hash under a different key, so a row alone can not be brute-forced', () => {
    const first = keyedHash('4821');
    process.env.CORTEX_INTERNAL_SECRET = 'another-secret';

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedHash('4821')).not.toEqual(first);
  });
});

describe('only scalars stay plain', () => {
  it.each([
    ['action', { arguments: '--password=hunter2' }],
    ['action', ['--password=hunter2']],
    ['process_name', { nested: { deep: 'hunter2' } }],
    ['task_name', [{ x: 'hunter2' }]],
  ])('a nested %s is walked, not written out', (field, value) => {
    const changes = launchChangesForCall('manage_scheduled_task', { [field]: value }, null);

    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('a number in a free-form field is hashed, and one in a known field is not', () => {
    const changes = launchChangesForCall(
      'manage_scheduled_task',
      { action: 'create', task_action: { pin: 4821 }, hour: 3 },
      null,
    );

    expect(JSON.stringify(changes)).not.toContain('4821');
    expect(changes.hour.to).toBe('3');
  });

  it('never writes a registry value that is a number', () => {
    const changes = launchChangesForCall('registry_operation', { action: 'write', value_data: 4821 }, null);

    expect(JSON.stringify(changes)).not.toContain('4821');
  });

  it('schedules still read in full', () => {
    const schedules = [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }];

    expect(launchChangesBetween(null, { schedules })!.schedules.to).toBe(JSON.stringify(schedules));
  });
});

describe('free-form arguments are never written as they are', () => {
  it.each([
    ['--api-key=hunter2', 'hunter2'],
    ['--token hunter2', 'hunter2'],
    ['--password "two words"', 'two words'],
    ['--pass hunter2', 'hunter2'],
    ['-phunter3', 'hunter3'],
    ['-p hunter2', 'hunter2'],
    ['/pw:hunter2', 'hunter2'],
    ['--key hunter2', 'hunter2'],
    ['-u bob:hunter2', 'hunter2'],
    ['--user=bob:hunter2', 'hunter2'],
    ['{"password":"hunter2"}', 'hunter2'],
    ['AuthKey=hunter2', 'hunter2'],
    ['set API_TOKEN=hunter2 && app.exe', 'hunter2'],
    ['Authorization: Basic aHVudGVyMg==', 'aHVudGVyMg'],
    ['Authorization: Bearer hunter2', 'hunter2'],
    ['https://hooks.slack.com/services/T00/B00/hunter2', 'hunter2'],
    ['https://host/app?access_token=hunter2&x=1', 'hunter2'],
    ['https://user:hunter2@host/app', 'hunter2'],
    ['C:\\apps\\tool.exe --pass hunter2', 'hunter2'],
    ['plainword', 'plainword'],
  ])('%s', (args, secret) => {
    const changes = launchChangesBetween(null, { file_path: args })!;

    expect(changes.file_path.to).toMatch(FINGERPRINT);
    expect(JSON.stringify(changes)).not.toContain(secret);
  });

  it('says a value changed, and its length, without saying what it was', () => {
    const changes = launchChangesBetween({ file_path: '--key one' }, { file_path: '--key two' })!;

    expect(changes.file_path.from).toMatch(/length:9\]$/);
    expect(changes.file_path.from).not.toEqual(changes.file_path.to);
  });
});

describe('paths stay readable', () => {
  it.each([
    'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
    'C:/shows/lobby.toe',
    '\\\\server\\share\\app.exe',
    '/usr/local/bin/app',
  ])('%s', (path) => {
    expect(launchChangesBetween(null, { exe_path: path })!.exe_path.to).toBe(path);
  });
});

describe('launchChangesBetween', () => {
  it('records only launch fields that changed', () => {
    expect(
      launchChangesBetween(
        { name: 'a', exe_path: 'C:\\old.exe', cwd: 'C:\\x', launch_mode: 'off', priority: 'Normal', time_delay: '0' },
        { name: 'b', exe_path: 'C:\\new.exe', cwd: 'C:\\x', launch_mode: 'always', priority: 'High', time_delay: '9' },
      ),
    ).toEqual({
      exe_path: { from: 'C:\\old.exe', to: 'C:\\new.exe' },
      launch_mode: { from: 'off', to: 'always' },
      time_delay: { from: '0', to: '9' },
    });
  });

  it('has nothing to say when only a display field moved', () => {
    expect(launchChangesBetween({ name: 'a', exe_path: 'x' }, { name: 'b', exe_path: 'x' })).toBeUndefined();
  });

  it('a create has no old values and a delete has no new ones', () => {
    expect(launchChangesBetween(null, { exe_path: 'C:\\x.exe', file_path: '' })).toEqual({
      exe_path: { from: null, to: 'C:\\x.exe' },
    });
    expect(launchChangesBetween({ exe_path: 'C:\\x.exe' }, null)).toEqual({ exe_path: { from: 'C:\\x.exe', to: null } });
  });

  it('writes schedules out', () => {
    expect(launchChangesBetween({ schedules: null }, { schedules: [{ days: ['mon'], ranges: [] }] })).toEqual({
      schedules: { from: null, to: '[{"days":["mon"],"ranges":[]}]' },
    });
  });

  it('caps a long value', () => {
    const changes = launchChangesBetween(null, { schedules: new Array(500).fill({ days: ['mon'] }) })!;
    expect(changes.schedules.to!.length).toBeLessThanOrEqual(1000);
  });
});

describe('launchChangesForCall', () => {
  const current = { name: 'TD', exe_path: 'C:\\old.exe', launch_mode: 'off', time_delay: '0' };

  it('update_process: old from the config, new from the call', () => {
    expect(launchChangesForCall('update_process', { process_name: 'TD', exe_path: 'C:\\new.exe' }, current)).toEqual({
      exe_path: { from: 'C:\\old.exe', to: 'C:\\new.exe' },
    });
  });

  it('add_process and delete_process have one side each', () => {
    expect(launchChangesForCall('add_process', { name: 'x', exe_path: 'C:\\x.exe' }, null)).toEqual({
      exe_path: { from: null, to: 'C:\\x.exe' },
    });
    expect(launchChangesForCall('delete_process', { process_name: 'TD' }, current)).toMatchObject({
      exe_path: { from: 'C:\\old.exe', to: null },
    });
  });

  it('set_launch_mode: old and new mode', () => {
    expect(launchChangesForCall('set_launch_mode', { process_name: 'TD', mode: 'always' }, current)).toEqual({
      launch_mode: { from: 'off', to: 'always' },
    });
  });

  it('an agent-run tool keeps its names and paths, and hashes everything else, nested or not', () => {
    const changes = launchChangesForCall(
      'manage_scheduled_task',
      {
        action: 'create',
        task_name: 'nightly',
        task_action: { program: 'C:\\app.exe', arguments: '--pass hunter2', password: 'hunter3' },
      },
      null,
    );

    expect(changes.action.to).toBe('create');
    expect(changes.task_name.to).toBe('nightly');
    expect(changes.task_action.to).toContain('app.exe');
    expect(JSON.stringify(changes)).not.toMatch(/hunter2|hunter3/);
  });

  it('a script is a hash and a length', () => {
    const changes = launchChangesForCall('run_powershell', { script: 'Start-Process calc -Credential hunter2' }, null);

    expect(changes.script.to).toMatch(FINGERPRINT);
  });

  it('never records a registry value, path-shaped or not', () => {
    const changes = launchChangesForCall(
      'registry_operation',
      { action: 'write', key_path: 'x', value_name: 'AuthKey', value_data: '/hunter2' },
      null,
    );

    expect(changes.value_name.to).toBe('AuthKey');
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });
});
