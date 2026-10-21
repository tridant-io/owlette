import { controlRefusedForCapability } from '@/lib/swoop/intent';

describe('controlRefusedForCapability', () => {
  it('is the route capability gate or swoop own capability_missing, on a 403 only', () => {
    expect(controlRefusedForCapability(403, null, 'capability not granted')).toBe(true);
    expect(controlRefusedForCapability(403, 'capability_missing', 'you do not have permission to do this.')).toBe(true);
  });

  it('is nothing else: a site switch, an exclusion, a cap, or a status that is not 403', () => {
    expect(controlRefusedForCapability(403, 'swoop_disabled', 'swoop is not enabled for this site.')).toBe(false);
    expect(controlRefusedForCapability(403, 'machine_excluded', 'swoop is excluded on this machine.')).toBe(false);
    expect(controlRefusedForCapability(403, 'session_cap_reached', 'this session reached its 12 hour limit.')).toBe(false);
    expect(controlRefusedForCapability(401, 'step_up_required', 'confirm your identity to take control.')).toBe(false);
    expect(controlRefusedForCapability(404, null, 'capability not granted')).toBe(false);
  });
});
