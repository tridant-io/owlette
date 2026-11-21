'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TOOL_TIER_DESCRIPTIONS, TOOL_TIER_LABELS, TOOL_TIERS } from '@/lib/apiKeyTypes';
import type { ToolTier } from '@/lib/mcp-tools';

/** The key's tool tier, shared by create and edit. */

interface Props {
  value: ToolTier;
  onChange: (tier: ToolTier) => void;
  disabled?: boolean;
}

export function ApiKeyToolTierField({ value, onChange, disabled = false }: Props) {
  // create and edit can both be mounted, so the select's id must be unique
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-foreground">tool tier</Label>
      <Select
        value={String(value)}
        onValueChange={(next) => onChange(Number(next) as ToolTier)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="bg-background border-border text-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TOOL_TIERS.map((tier) => (
            <SelectItem key={tier} value={String(tier)}>
              {TOOL_TIER_LABELS[tier]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{TOOL_TIER_DESCRIPTIONS[value]}</p>
      <p className="text-xs text-muted-foreground">
        the highest tier of hoot tool this key can run on a machine through the api. tier 2 and 3
        need you signed in with a second factor.
      </p>
    </div>
  );
}
