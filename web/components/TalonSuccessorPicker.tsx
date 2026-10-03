'use client';

import React from 'react';
import { Zap } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Departure warning: how many talons this person wrote, what happens to them,
 * and who can inherit. Shown in the two flows that revoke access (site removal,
 * account deletion), which previously succeeded silently and left automations
 * owned by someone who could no longer run them.
 *
 * Renders nothing at zero — no paragraph about talons in the common case.
 */

/** Radix Select has no empty-string value, so "nobody" needs a sentinel. */
export const NO_SUCCESSOR = '__none__';

export interface TalonSuccessorCandidate {
  uid: string;
  label: string;
}

interface TalonSuccessorPickerProps {
  /** How many talons the departing person authored. Zero renders nothing. */
  count: number;
  /** Names of those talons, for the "which ones?" question. */
  talonNames: string[];
  /** What takes the author's access away, e.g. "they lose access to this site". */
  consequence: string;
  /** Admins eligible to inherit — the caller filters to who actually qualifies. */
  candidates: TalonSuccessorCandidate[];
  /** Selected successor uid, or {@link NO_SUCCESSOR}. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Distinguishes the label/select pair when two pickers exist on one page. */
  idPrefix?: string;
}

/** How many talon names to spell out before collapsing the rest into a tally. */
const NAMES_SHOWN = 5;

export function TalonSuccessorPicker({
  count,
  talonNames,
  consequence,
  candidates,
  value,
  onChange,
  disabled = false,
  idPrefix = 'talon-successor',
}: TalonSuccessorPickerProps) {
  if (count <= 0) return null;

  const shown = talonNames.slice(0, NAMES_SHOWN);
  const hidden = talonNames.length - shown.length;
  const selectId = `${idPrefix}-select`;

  return (
    <div className="rounded-lg border border-warning-border bg-warning-surface p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            this person wrote {count} talon{count === 1 ? '' : 's'}
          </p>
          <p className="text-sm text-muted-foreground">
            these will stop running when {consequence}. hand them to another admin to keep
            them alive.
          </p>
        </div>
      </div>

      {shown.length > 0 && (
        <ul className="ml-6 list-disc space-y-0.5 text-xs text-muted-foreground">
          {shown.map((name, index) => (
            <li key={`${name}-${index}`} className="truncate">
              {name}
            </li>
          ))}
          {hidden > 0 && <li>and {hidden} more</li>}
        </ul>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={selectId} className="text-xs text-muted-foreground">
          reassign to
        </Label>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={selectId} className="w-full border-border bg-secondary text-foreground">
            <SelectValue placeholder="choose an admin" />
          </SelectTrigger>
          <SelectContent className="border-border bg-card">
            <SelectItem
              value={NO_SUCCESSOR}
              className="text-foreground focus:bg-accent focus:text-foreground"
            >
              nobody — let these talons stop
            </SelectItem>
            {candidates.map((candidate) => (
              <SelectItem
                key={candidate.uid}
                value={candidate.uid}
                className="text-foreground focus:bg-accent focus:text-foreground"
              >
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {candidates.length === 0 && (
          <p className="text-xs text-warning">
            no other admin has access to take these over — promote someone first, or accept
            that they stop.
          </p>
        )}
      </div>
    </div>
  );
}
