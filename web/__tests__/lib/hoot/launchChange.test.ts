import { readFileSync } from 'fs';
import path from 'path';
import {
  callTier,
  changesWhatMachineLaunches,
  isClassifiedTool,
  launchChangeInputs,
  registryValueRefusal,
  unattendedRefusal,
  withoutSecretRegistryValues,
} from '@/lib/hoot/launchChange';
import { allTools } from '@/lib/mcp-tools';

const registryCases = JSON.parse(
  readFileSync(path.join(__dirname, '../../../../agent/tests/fixtures/registry_refusals.json'), 'utf8'),
) as { refused: Array<Record<string, string>>; allowed: Array<Record<string, string>> };

describe('changesWhatMachineLaunches', () => {
  it('fails closed on a field or action it does not know', () => {
    expect(changesWhatMachineLaunches('update_process', { process_name: 'x', env: { A: '1' } })).toBe(true);
    expect(changesWhatMachineLaunches('manage_scheduled_task', {})).toBe(true);
    expect(changesWhatMachineLaunches('manage_scheduled_task', { action: ['list'] })).toBe(true);
    expect(changesWhatMachineLaunches('manage_windows_service', { action: 'new_action' })).toBe(true);
    expect(changesWhatMachineLaunches('manage_windows_update', { action: 'new_action' })).toBe(true);
    expect(changesWhatMachineLaunches('manage_windows_feature', {})).toBe(true);
    expect(changesWhatMachineLaunches('registry_operation', {})).toBe(true);
    expect(changesWhatMachineLaunches('create_talon', {})).toBe(true);
    expect(changesWhatMachineLaunches('create_talon', { outputs: 'x' })).toBe(true);
    expect(changesWhatMachineLaunches('set_talon_enabled', { enabled: 'yes' })).toBe(true);
  });

  // these decide when a relaunch happens: time_delay sleeps before it, time_to_init
  // holds it, and relaunch_attempts sets when a crash loop asks for a reboot.
  it.each(['time_delay', 'time_to_init', 'relaunch_attempts'])('%s is a change to when it launches', (field) => {
    expect(changesWhatMachineLaunches('update_process', { process_name: 'x', [field]: '86400' })).toBe(true);
  });

  it.each(['name', 'priority', 'visibility'])('%s leaves what runs and when alone', (field) => {
    expect(changesWhatMachineLaunches('update_process', { process_name: 'x', [field]: 'y' })).toBe(false);
  });

  it.each([
    ['manage_windows_feature', 'install', true],
    ['manage_windows_feature', 'remove', true],
    ['manage_windows_feature', 'list', false],
    ['manage_windows_update', 'set_scheduled_install', true],
    ['manage_windows_update', 'get_status', false],
    ['manage_windows_update', 'pause', false],
    ['manage_windows_update', 'limit_auto_restart', false],
  ])('%s %s: %s', (tool, action, expected) => {
    expect(changesWhatMachineLaunches(tool, { action })).toBe(expected);
  });

  it.each(['start_process', 'kill_process', 'restart_process'])(
    '%s stays free, so unattended restarts keep working',
    (tool) => {
      expect(changesWhatMachineLaunches(tool, { process_name: 'x' })).toBe(false);
    },
  );

  it('asks about any talon that acts by itself, and none that only looks', () => {
    expect(
      changesWhatMachineLaunches('create_talon', {
        outputs: [{ type: 'command', commandType: 'stop_process' }],
      }),
    ).toBe(true);
    expect(
      changesWhatMachineLaunches('create_talon', {
        outputs: [{ type: 'email' }, { type: 'webhook', url: 'https://x' }, { type: 'cortex', directive: 'look' }],
      }),
    ).toBe(false);
  });

  it('says no for a read and a reboot', () => {
    expect(changesWhatMachineLaunches('get_system_info', {})).toBe(false);
    expect(changesWhatMachineLaunches('reboot_machine', {})).toBe(false);
  });
});

describe('callTier', () => {
  it("counts a launch change as tier 3, whatever its tool's tier", () => {
    expect(callTier('update_process', { process_name: 'x', exe_path: 'C:\\new.exe' }, 2)).toBe(3);
    expect(callTier('registry_operation', { action: 'write' }, 2)).toBe(3);
  });

  it("leaves any other call at its tool's tier", () => {
    expect(callTier('update_process', { process_name: 'x', priority: 'High' }, 2)).toBe(2);
    expect(callTier('get_system_info', {}, 1)).toBe(1);
    expect(callTier('reboot_machine', {}, 3)).toBe(3);
  });
});

describe('every tool is classified', () => {
  it.each(allTools.map((tool) => tool.name))('%s', (name) => {
    expect(isClassifiedTool(name)).toBe(true);
  });

  // a read need not name its machines in a turn on several, so it must never be a launch change
  it.each(allTools.filter((tool) => tool.tier === 1).map((tool) => tool.name))(
    '%s, a read, never changes what a machine launches',
    (name) => {
      expect(changesWhatMachineLaunches(name, { action: 'anything', field: 'x' })).toBe(false);
    },
  );

  it('a tool nobody classified needs a person, and is refused with nobody there', () => {
    expect(isClassifiedTool('brand_new_tool')).toBe(false);
    expect(changesWhatMachineLaunches('brand_new_tool', {})).toBe(true);
    expect(unattendedRefusal('brand_new_tool', {})).toMatchObject({ error: 'launch_change_needs_approval' });
  });
});

describe('the unattended refusal', () => {
  it.each(['run_command', 'run_powershell', 'run_python', 'execute_script', 'write_file', 'deploy_software'])(
    '%s can run anything, so it always asks',
    (name) => {
      expect(changesWhatMachineLaunches(name, {})).toBe(true);
      expect(unattendedRefusal(name, {})).toMatchObject({ error: 'launch_change_needs_approval' });
    },
  );

  it.each(['reboot_machine', 'shutdown_machine', 'read_file', 'list_directory', 'restart_process'])(
    '%s is not refused',
    (name) => {
      expect(changesWhatMachineLaunches(name, {})).toBe(false);
      expect(unattendedRefusal(name, {})).toBeNull();
    },
  );

  it('refuses a launch change, and lets a rename through', () => {
    expect(unattendedRefusal('add_process', { name: 'x' })).toMatchObject({ ok: false, status: 403 });
    expect(unattendedRefusal('update_process', { process_name: 'x', name: 'y' })).toBeNull();
  });
});

describe('registryValueRefusal, on the same table as the agent', () => {
  it.each(registryCases.refused)('refuses %j', (call) => {
    expect(registryValueRefusal('registry_operation', { hive: 'HKLM', ...call })).toMatchObject({
      ok: false,
      error: 'registry_value_refused',
      status: 403,
    });
  });

  it.each(registryCases.allowed)('lets %j through', (call) => {
    expect(registryValueRefusal('registry_operation', { hive: 'HKLM', ...call })).toBeNull();
  });

  it('has no opinion on another tool', () => {
    expect(registryValueRefusal('get_system_info', { key_path: 'x' })).toBeNull();
  });
});

describe('withoutSecretRegistryValues', () => {
  it('takes a secret out of what a fielded agent lists', () => {
    expect(
      withoutSecretRegistryValues('registry_operation', {
        values: [
          { name: 'ApiToken', value: 'abc' },
          { name: 'Port', value: 80 },
        ],
      }),
    ).toEqual({ values: [{ name: 'Port', value: 80 }] });
  });

  it('leaves everything else as it was', () => {
    const result = { values: [{ name: 'ApiToken', value: 'abc' }] };
    expect(withoutSecretRegistryValues('get_system_info', result)).toBe(result);
    expect(withoutSecretRegistryValues('registry_operation', { error: 'x' })).toEqual({ error: 'x' });
  });
});

describe('launchChangeInputs', () => {
  it('names the process and what changes, and hides what it keeps', () => {
    expect(
      launchChangeInputs('update_process', {
        process_name: 'TD',
        name: 'x',
        exe_path: 'C:\\new.exe',
        schedules: [],
        time_delay: '5',
      }),
    ).toEqual([
      ['process_name', 'TD'],
      ['exe_path', 'C:\\new.exe'],
      ['schedules', '[]'],
      ['time_delay', '5'],
    ]);
  });

  it('shows every argument of any other launch change', () => {
    expect(launchChangeInputs('set_launch_mode', { process_name: 'TD', mode: 'always' })).toEqual([
      ['process_name', 'TD'],
      ['mode', 'always'],
    ]);
  });

  it('shows nothing for a call that changes nothing', () => {
    expect(launchChangeInputs('update_process', { process_name: 'TD', name: 'x' })).toEqual([]);
    expect(launchChangeInputs('get_system_info', {})).toEqual([]);
  });

  // the server takes the list out before it classifies a call, and the card names the machines itself
  it('leaves out the machines a call names', () => {
    expect(launchChangeInputs('set_launch_mode', { process_name: 'TD', mode: 'always', machines: ['m1'] })).toEqual([
      ['process_name', 'TD'],
      ['mode', 'always'],
    ]);
    expect(launchChangeInputs('update_process', { process_name: 'TD', priority: 'High', machines: ['m1'] })).toEqual([]);
  });
});
