/**
 * /demo's sample machines. tsc already holds every `Machine` field to a
 * decision (`EveryField` in demo-data.ts); this checks the pieces that must
 * agree at run time: the switcher's count, the fleet's spread, and each
 * machine's devices against its live metrics and its chart series.
 */
import {
  DEMO_SITE_ID,
  DEMO_SITE_MACHINE_COUNTS,
  getDemoDisplayState,
  getDemoHistoricalData,
  getDemoMachines,
} from '@/lib/demo-data';

const machines = getDemoMachines();

it("the switcher's count is the number of demo machines", () => {
  expect(DEMO_SITE_MACHINE_COUNTS).toEqual({ [DEMO_SITE_ID]: machines.length });
});

it('the fleet runs windows, macOS and linux, each machine with its os line, and one mac asleep', () => {
  expect(new Set(machines.map((m) => m.osFamily))).toEqual(new Set(['windows', 'macos', 'linux']));
  expect(machines.every((m) => m.osVersion)).toBe(true);
  expect(machines.filter((m) => m.asleep).map((m) => [m.osFamily, m.online])).toEqual([['macos', false]]);
});

it('every gpu is one the agent reads: nvidia on any os, apple on a mac', () => {
  const gpus = machines.flatMap((m) => (m.profile?.gpus ?? []).map((g) => [m.osFamily, g.name]));
  expect(gpus.length).toBeGreaterThan(0);
  for (const [osFamily, name] of gpus) {
    expect(name).toMatch(osFamily === 'macos' ? /^Apple / : /^NVIDIA /);
  }
});

it('only windows machines report displays, as the agent manages layouts only there', () => {
  for (const m of machines.filter((m) => m.osFamily !== 'windows')) {
    expect(getDemoDisplayState(m.machineId).profile).toBeNull();
  }
});

describe.each(machines.filter((m) => m.online && !m.rebooting).map((m) => [m.machineId, m] as const))(
  '%s',
  (_id, machine) => {
    it('every profiled device has a live metric', () => {
      const devices = Object.values(machine.devices!).flat();
      expect(devices.filter((d) => d.isMissing || d.isOrphan)).toEqual([]);
    });

    it('the charts carry a series for each disk and the primary adapter', () => {
      const [point] = getDemoHistoricalData(machine.machineId, '1h');
      for (const disk of machine.profile!.disks) expect(point).toHaveProperty([`${disk.id}_pct`]);
      expect(point).toHaveProperty([`${machine.metrics!.primary!.nic}_tx_util`]);
    });
  },
);
