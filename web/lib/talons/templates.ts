/**
 * Built-in talon presets — the templates every site starts with. Plain data,
 * merged client-side over `config/{siteId}/talon_presets`. CLIENT-SAFE: no
 * server imports, no Firestore. Parallel to `@/lib/restartDefaults` et al.
 *
 * Every `template` goes straight to `validateTalonPresetInput`; templates.test.ts
 * proves each passes. Ship nothing that does not.
 *
 * Two load-bearing rules:
 *   - `name` is IDENTITY — `builtInId()` derives `builtin-<slug>` from it, so a
 *     rename orphans every site's override into the "custom" bucket.
 *   - No `scope`, `enabled`, or command-output `processId`: all per-instance.
 */
import type { TalonPresetRequirement, TalonPresetTemplate } from './types';

/**
 * `requires` is machine-checked: the test asserts a template declaring
 * `process_target` fails validation on exactly that path. `llm_key` is the
 * author's own key (`users/{uid}/settings/llm`), checked by the store on create,
 * update and enable; `process_target` is left blank because a process id does
 * not travel between sites.
 */
export interface TalonTemplateDefinition {
  /** Deterministic `builtin-<slug>`, matching `useRestartPresets`' `builtInId()`. */
  id: string;
  /** Lowercase and STABLE — renaming orphans a site's override of this preset. */
  name: string;
  /** Lowercase one-liner, in the voice of the other preset families. */
  description: string;
  /** Picker one-liner, lowercase. */
  summary: string;
  requires: TalonPresetRequirement[];
  template: TalonPresetTemplate;
}

/** Every day of the week, in canonical order — what the validator normalizes to. */
const EVERY_DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * Wall-check expectation. Redundant with the vision prompt, which already treats
 * these as failures — spelled out because the operator reads and edits it.
 */
const WALL_EXPECTATION =
  'the screen should be showing the content loop. it should not show the windows ' +
  'desktop or taskbar, an error dialog, a black or blank screen, or a "no signal" card.';

/**
 * Cooldown is global to the TALON, not per machine, so a long one on a
 * fleet-wide event template silently drops the second machine's event — hence 5
 * minutes there. The 60-minute default is inert for schedules (`nextRunAt`
 * already spaces those runs).
 */
const EVENT_COOLDOWN_MINUTES = 5;
const DEFAULT_COOLDOWN_MINUTES = 60;

export const BUILT_IN_TALON_PRESETS: TalonTemplateDefinition[] = [
  {
    id: 'builtin-morning-wall-check',
    name: 'morning wall check',
    description: 'at 8 am, look at every screen and email if it is not showing content',
    summary: 'the walk-the-floor check, done by hoot before anyone arrives',
    requires: ['llm_key'],
    template: {
      name: 'morning wall check',
      description: 'at 8 am, look at every screen and email if it is not showing content',
      trigger: {
        type: 'schedule',
        entries: [{ id: 'tpl-morning-wall-check', days: [...EVERY_DAY], time: '08:00' }],
      },
      condition: { type: 'visual_check', expectation: WALL_EXPECTATION },
      outputs: [{ type: 'email' }],
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-crash-triage',
    name: 'crash triage',
    description: 'when a process crashes, hoot investigates and writes up what it found',
    summary: 'the diagnosis is waiting in a chat before anyone opens the dashboard',
    requires: ['llm_key'],
    template: {
      name: 'crash triage',
      description: 'when a process crashes, hoot investigates and writes up what it found',
      trigger: { type: 'event', eventTypes: ['process_crash', 'process_start_failed'] },
      condition: { type: 'none' },
      outputs: [
        {
          type: 'cortex',
          // No `allowActions`, so the turn has read-only tools only — an
          // instruction to restart anything would just fail confusingly.
          directive:
            'a monitored process just went down on this machine. work out why: check the ' +
            'windows event log around the crash, recent cpu, memory and gpu load, free disk ' +
            'space, and whether the executable is still where owlette expects it. do not try ' +
            'to restart anything — report what you found and what you would do next.',
        },
      ],
      cooldownMinutes: 30,
    },
  },
  {
    id: 'builtin-weekly-health-report',
    name: 'weekly health report',
    description: 'every monday at 9 am, hoot writes a plain-language health report',
    summary: 'a monday-morning readout of what each machine has been putting up with',
    requires: ['llm_key'],
    template: {
      name: 'weekly health report',
      description: 'every monday at 9 am, hoot writes a plain-language health report',
      trigger: {
        type: 'schedule',
        entries: [{ id: 'tpl-weekly-health-report', days: ['mon'], time: '09:00' }],
      },
      condition: { type: 'none' },
      outputs: [
        {
          type: 'cortex',
          // Every item maps to a tier-1 tool the unattended turn actually has,
          // so the report can never come back half-empty.
          directive:
            'write a short health report for this machine in plain language, for someone who ' +
            'is not a windows administrator. cover: free disk space on every drive, recent ' +
            'errors in the windows event log, whether a reboot is pending and why, and ' +
            'whether windows update is healthy. finish with one paragraph saying whether ' +
            'this machine is fine, worth watching, or needs attention, and why.',
        },
      ],
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-exe-went-missing',
    name: 'exe went missing',
    description: 'email when a process executable is no longer where owlette expects it',
    summary: 'an app update moved the exe and the process can never launch again',
    requires: [],
    template: {
      name: 'exe went missing',
      description: 'email when a process executable is no longer where owlette expects it',
      trigger: { type: 'event', eventTypes: ['exe_missing'] },
      condition: { type: 'none' },
      outputs: [{ type: 'email' }],
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-wall-check-after-restart',
    name: 'wall check after restart',
    description: 'three minutes after a process restarts, confirm the screen came back',
    summary: 'catches the restart that technically worked but left a black screen',
    requires: ['llm_key'],
    template: {
      name: 'wall check after restart',
      description: 'three minutes after a process restarts, confirm the screen came back',
      trigger: {
        type: 'event',
        eventTypes: ['process_restarted'],
        // A screenshot taken the instant a process restarts catches a splash
        // screen and reads as a failure; three minutes clears that.
        delayMinutes: 3,
      },
      condition: {
        type: 'visual_check',
        expectation:
          'after the restart the screen should be back on its content loop. it should not ' +
          'show the windows desktop or taskbar, an error dialog, a loading indicator that ' +
          'never finishes, or a black or blank screen.',
      },
      outputs: [{ type: 'email' }],
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-update-guard',
    name: 'update guard',
    description: 'every sunday at 7 am, re-assert the update window and the setup-screen suppression',
    summary: 'windows update and its full-screen nag screens never interrupt the exhibit',
    requires: ['llm_key'],
    template: {
      name: 'update guard',
      description: 'every sunday at 7 am, re-assert the update window and the setup-screen suppression',
      trigger: {
        type: 'schedule',
        entries: [{ id: 'tpl-update-guard', days: ['sun'], time: '07:00' }],
      },
      condition: { type: 'none' },
      outputs: [
        {
          type: 'cortex',
          // Ships un-armed: the tools named here are tier 2, so it only fixes
          // drift once an admin turns on "let hoot act". The directive's first
          // instruction makes that state self-explaining, not a half-failure.
          directive:
            'keep windows update and its setup screens from ever interrupting the exhibit. ' +
            'if the manage_windows_update and suppress_setup_screens tools are not available ' +
            'in this session, this talon is not armed to act: report that a site admin needs ' +
            'to turn on "let hoot act" on this talon, then stop. otherwise: 1) call ' +
            'manage_windows_update get_status. if no install schedule is configured, set ' +
            'installs for tuesday 3 am. if active hours come from the windows default, call ' +
            'manage_windows_update limit_auto_restart with start_hour 7 and end_hour 23; if ' +
            'they were already chosen but get_status lists a restart deadline, call ' +
            'limit_auto_restart with no hours, which keeps them. leave anything else already ' +
            'configured alone and note it. 2) call suppress_setup_screens with action apply — ' +
            'it is idempotent — and name any profile that had drifted. 3) call ' +
            'check_pending_reboot and say plainly whether a reboot is waiting. finish with ' +
            'a short summary of what drifted, what you fixed, and anything needing a human.',
        },
      ],
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    },
  },
];
