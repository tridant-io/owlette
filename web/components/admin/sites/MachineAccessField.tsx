'use client';

import { SegmentedControl } from '@/components/admin/SegmentedControl';
import { MultiSelect } from '@/components/ui/multi-select';
import { MAX_MACHINE_SCOPE } from '@/lib/machineAccess';

type AccessChoice = 'whole' | 'some';

const ACCESS_CHOICES: readonly { value: AccessChoice; label: string }[] = [
  { value: 'whole', label: 'whole site' },
  { value: 'some', label: 'some machines' },
];

const ACCESS_HINTS: Record<AccessChoice, string> = {
  whole: 'every machine, and the site-wide pages their role allows: settings, members, deployments, roost and talons.',
  some: 'only the machines you pick: their role and swoop apply there. nothing site-wide, whatever their role.',
};

/** what the members api accepts: null for the whole site, else 1 to MAX_MACHINE_SCOPE machines */
export function isAccessValid(value: readonly string[] | null): boolean {
  return value === null || (value.length >= 1 && value.length <= MAX_MACHINE_SCOPE);
}

export function accessLabel(machineIds: readonly string[] | null): string {
  if (machineIds === null) return 'whole site';
  if (machineIds.length === 0) return 'no machines';
  return machineIds.length === 1 ? '1 machine' : `${machineIds.length} machines`;
}

/** the picked ids that are still machines of the site: the api refuses a save that names one that has gone */
export function liveMachineIds(value: readonly string[], machines: readonly { id: string }[]): string[] {
  const live = new Set(machines.map((m) => m.id));
  return value.filter((id) => live.has(id));
}

function scopeProblem(value: readonly string[]): string | null {
  if (value.length === 0) return 'pick at least one machine';
  if (value.length > MAX_MACHINE_SCOPE) return `at most ${MAX_MACHINE_SCOPE} machines`;
  return null;
}

/**
 * the machines half of a person's access, where null is the whole site. "some
 * machines" is a choice of its own because MultiSelect reads an empty selection,
 * and its "none" button, as everything. here empty means no machine picked yet,
 * which stays invalid until one is.
 */
export function MachineAccessField({
  machines,
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  machines: { id: string; name: string }[];
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const choice: AccessChoice = value === null ? 'whole' : 'some';
  const problem = value === null ? null : scopeProblem(value);

  return (
    // a fieldset, because neither control takes a disabled prop: it disables every button inside
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      {/* the group below carries the same name, so a screen reader hears it once */}
      <p aria-hidden="true" className="text-sm leading-none font-medium">
        access
      </p>
      <div className="flex">
        <SegmentedControl
          label="access"
          options={ACCESS_CHOICES}
          value={choice}
          onChange={(next) => {
            if (next !== choice) onChange(next === 'whole' ? null : []);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{ACCESS_HINTS[choice]}</p>
      {value !== null && (
        <>
          <MultiSelect
            groups={[{ group: null, options: machines.map((m) => ({ value: m.id, label: m.name })) }]}
            selected={value}
            onChange={onChange}
            allLabel="pick machines"
            itemNoun="machines"
            searchPlaceholder="search machines…"
            data-testid={`${idPrefix}-machines`}
          />
          {problem && <p className="text-xs text-danger">{problem}</p>}
        </>
      )}
    </fieldset>
  );
}
