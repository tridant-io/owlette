/**
 * BUILT_IN_TALON_PRESETS. Each `template` goes through the real talon validator, so a shipped
 * template that couldn't be saved fails here instead of becoming a support ticket. `requires`
 * is checked the same way: a template claiming it needs a process target must actually fail on
 * that field, and one claiming nothing must pass outright.
 */

import {
  BUILT_IN_TALON_PRESETS,
  type TalonTemplateDefinition,
} from '@/lib/talons/templates';
import { validateTalonPresetInput } from '@/lib/talons/validation';
import type { TalonOutput } from '@/lib/talons/types';

/** The id `useRestartPresets`' built-in merge derives from a preset's name. */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function commandOutputs(def: TalonTemplateDefinition): TalonOutput[] {
  return def.template.outputs.filter((output) => output.type === 'command');
}

describe('BUILT_IN_TALON_PRESETS', () => {
  it('ships a usable set', () => {
    expect(BUILT_IN_TALON_PRESETS.length).toBeGreaterThan(0);
    // Site cap is 20 talons — dozens of equally weighted options invite burning half that
    // budget on presets nobody tunes.
    expect(BUILT_IN_TALON_PRESETS.length).toBeLessThanOrEqual(8);
  });

  it('derives every id from its own name', () => {
    // `builtInId` is derived client-side from the hardcoded name; a disagreement orphans
    // every site's override of that preset.
    for (const def of BUILT_IN_TALON_PRESETS) {
      expect(def.id).toBe(builtInId(def.name));
    }
  });

  it('has unique names (case-insensitive)', () => {
    const names = BUILT_IN_TALON_PRESETS.map((def) => def.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(BUILT_IN_TALON_PRESETS)(
    'preset "$name" writes its copy in the lowercase voice of the ui',
    (def: TalonTemplateDefinition) => {
      for (const copy of [def.name, def.description, def.summary, def.template.name]) {
        expect({ copy, lowercase: /^[a-z]/.test(copy) }).toEqual({ copy, lowercase: true });
      }
    },
  );

  it.each(BUILT_IN_TALON_PRESETS)(
    'preset "$name" carries no scope, enabled, or process id',
    (def: TalonTemplateDefinition) => {
      const template = def.template as unknown as Record<string, unknown>;
      expect(template.scope).toBeUndefined();
      expect(template.enabled).toBeUndefined();
      // Process ids are per-machine config ids — they don't travel, and a stale one fails
      // silently at run time.
      for (const output of commandOutputs(def)) {
        expect((output as unknown as Record<string, unknown>).processId).toBeUndefined();
      }
    },
  );

  it.each(BUILT_IN_TALON_PRESETS)(
    'preset "$name" does not ship a hoot output pre-armed to act',
    (def: TalonTemplateDefinition) => {
      // `allowActions` hands an unattended turn process control — nothing ships opted in.
      for (const output of def.template.outputs) {
        expect((output as unknown as Record<string, unknown>).allowActions).toBeUndefined();
      }
    },
  );

  it.each(BUILT_IN_TALON_PRESETS)(
    'preset "$name" declares llm_key exactly when it needs the model',
    (def: TalonTemplateDefinition) => {
      const needsLlm =
        def.template.condition.type === 'visual_check' ||
        def.template.outputs.some((output) => output.type === 'cortex');
      expect({ name: def.name, declared: def.requires.includes('llm_key') }).toEqual({
        name: def.name,
        declared: needsLlm,
      });
    },
  );

  it('update guard holds restarts to outside active hours and never sets a deadline', () => {
    // set_restart_deadline is gone: it wrote where windows never reads, and a deadline only
    // ever forces a restart, inside active hours once it passes.
    const guard = BUILT_IN_TALON_PRESETS.find((def) => def.id === 'builtin-update-guard');
    const directive = (guard?.template.outputs ?? [])
      .map((output) => (output.type === 'cortex' ? output.directive : ''))
      .join(' ');

    expect(directive).toContain('limit_auto_restart');
    expect(directive).not.toMatch(/set_restart_deadline|day restart deadline/);
  });

  it.each(BUILT_IN_TALON_PRESETS)(
    'preset "$name" validates exactly as strictly as it claims',
    (def: TalonTemplateDefinition) => {
      const result = validateTalonPresetInput(def.template);

      if (!def.requires.includes('process_target')) {
        // Report the errors, not a boolean, so a failure names the rule that broke.
        expect(result.ok ? [] : result.errors).toEqual([]);
        return;
      }

      expect(result.ok).toBe(false);
      const fields = result.ok ? [] : result.errors.map((error) => error.field);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field).toMatch(/^template\.outputs\[\d+\]\.processId$/);
      }
    },
  );
});
