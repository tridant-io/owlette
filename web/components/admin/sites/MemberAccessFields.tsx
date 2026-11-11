'use client';

import { MachineAccessField } from '@/components/admin/sites/MachineAccessField';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AddableSiteMemberRole } from '@/hooks/useSiteMembers';
import { SWOOP_MODES, SWOOP_MODE_LABELS, type SwoopMode } from '@/lib/swoopMode';

/** the swoop select's value. `'default'` is a row with no `swoop` field, so the role decides. */
export type SwoopChoice = 'default' | SwoopMode;

export function toSwoopChoice(mode: SwoopMode | null): SwoopChoice {
  return mode ?? 'default';
}

export function fromSwoopChoice(choice: SwoopChoice): SwoopMode | null {
  return choice === 'default' ? null : choice;
}

const ROLE_HINTS: Record<AddableSiteMemberRole, string> = {
  member: 'views machines, takes screenshots and opens live view. no commands and no configuration.',
  admin:
    'runs the site: everything a member can, plus commands and configuration, swoop settings, deployments, roosts, talons, webhooks, alert rules, pairing machines and managing members.',
};

const SWOOP_CHOICES: readonly { value: SwoopChoice; label: string }[] = [
  { value: 'default', label: 'by role' },
  ...SWOOP_MODES.map((mode) => ({ value: mode, label: SWOOP_MODE_LABELS[mode] })),
];

const SWOOP_HINTS: Record<SwoopMode, string> = {
  none: "can't open swoop on this site's machines.",
  view: 'watches, and never takes control.',
  control: 'watches, and takes control after confirming a second factor.',
};

function swoopHint(swoop: SwoopChoice, role: AddableSiteMemberRole, membersMayWatch: boolean): string {
  if (swoop !== 'default') return SWOOP_HINTS[swoop];
  if (role === 'admin') return 'by role: an admin watches and takes control.';
  return membersMayWatch ? 'by role: a member watches.' : "by role: members don't watch on this site.";
}

const TRIGGER_CLASS = 'w-full border-border bg-secondary text-foreground';
const ITEM_CLASS = 'text-foreground focus:bg-accent focus:text-foreground';

export function MemberAccessFields({
  idPrefix,
  role,
  swoop,
  onRoleChange,
  onSwoopChange,
  membersMayWatch,
  machines,
  machineIds,
  onMachineIdsChange,
  disabled,
}: {
  idPrefix: string;
  role: AddableSiteMemberRole;
  swoop: SwoopChoice;
  onRoleChange: (r: AddableSiteMemberRole) => void;
  onSwoopChange: (c: SwoopChoice) => void;
  membersMayWatch: boolean;
  machines: { id: string; name: string }[];
  /** null is the whole site */
  machineIds: string[] | null;
  onMachineIdsChange: (next: string[] | null) => void;
  disabled?: boolean;
}) {
  const roleId = `${idPrefix}-role`;
  const swoopId = `${idPrefix}-swoop`;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={roleId}>role</Label>
        <Select
          value={role}
          onValueChange={(value) => onRoleChange(value as AddableSiteMemberRole)}
          disabled={disabled}
        >
          <SelectTrigger id={roleId} aria-describedby={`${roleId}-hint`} className={TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-border bg-card">
            <SelectItem value="member" className={ITEM_CLASS}>
              member
            </SelectItem>
            <SelectItem value="admin" className={ITEM_CLASS}>
              admin
            </SelectItem>
          </SelectContent>
        </Select>
        <p id={`${roleId}-hint`} className="text-xs text-muted-foreground">
          {ROLE_HINTS[role]}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={swoopId}>swoop</Label>
        <Select
          value={swoop}
          onValueChange={(value) => onSwoopChange(value as SwoopChoice)}
          disabled={disabled}
        >
          <SelectTrigger id={swoopId} aria-describedby={`${swoopId}-hint`} className={TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-border bg-card">
            {SWOOP_CHOICES.map(({ value, label }) => (
              <SelectItem key={value} value={value} className={ITEM_CLASS}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id={`${swoopId}-hint`} className="text-xs text-muted-foreground">
          {swoopHint(swoop, role, membersMayWatch)}
        </p>
      </div>
      <MachineAccessField
        idPrefix={`${idPrefix}-machines`}
        machines={machines}
        value={machineIds}
        onChange={onMachineIdsChange}
        disabled={disabled}
      />
    </div>
  );
}
