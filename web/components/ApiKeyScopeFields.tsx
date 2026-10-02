'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';
import {
  ALL_RESOURCES,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  type ApiKeyScopePreset,
  SCOPE_PRESET_DESCRIPTIONS,
  SCOPE_PRESET_KEYS,
  SCOPE_PRESET_LABELS,
  SCOPE_PRESETS,
} from '@/lib/apiKeyTypes';

/**
 * Preset picker and custom-scope builder, shared by create and edit. Both surfaces must offer the
 * same expressive range — the server validates PATCH with the same code as POST, so a narrower
 * edit builder would strand keys in states the UI can create but not correct.
 */

export type ScopeSelection = ApiKeyScopePreset | 'custom';

const RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES;
const PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];

/** Expand a selection into the scope array the API takes. */
export function resolveScopes(preset: ScopeSelection, customScopes: ApiKeyScope[]): ApiKeyScope[] {
  return preset === 'custom' ? customScopes : SCOPE_PRESETS[preset];
}

/**
 * Seed for the custom builder when the selection changes; null when no re-seed is needed.
 *
 * Entering `custom` from a named preset carries that preset's scopes in, so the switch refines
 * rather than resets. Without it, operator → custom silently replaced 4 scopes and 16 grants with
 * one unrelated `site` row, passed every validator, and returned 200.
 *
 * Only on the way IN to custom — picking a named preset while already in custom is an explicit
 * "replace my selection".
 */
export function customScopesForSelection(
  next: ScopeSelection,
  current: ScopeSelection,
  customScopes: ApiKeyScope[],
): ApiKeyScope[] | null {
  if (next !== 'custom' || current === 'custom') return null;
  return resolveScopes(current, customScopes).map((s) => ({
    ...s,
    // SCOPE_PRESETS entries are module-level singletons and wildcardScopes shares one permissions
    // array across all four rows; the builder mutates what it is given, so copy.
    permissions: [...s.permissions],
  }));
}

/** Client-side pre-flight. Returns a message, or null when the selection is submittable. */
export function validateScopeSelection(
  preset: ScopeSelection,
  customScopes: ApiKeyScope[],
): string | null {
  if (preset !== 'custom') return null;
  if (customScopes.length === 0) return 'add at least one scope';
  for (let i = 0; i < customScopes.length; i++) {
    const s = customScopes[i];
    if (!s.id || s.id.trim().length === 0) return `scope ${i + 1}: id is required (use * for all)`;
    if (s.permissions.length === 0) return `scope ${i + 1}: pick at least one permission`;
  }
  return null;
}

function sameScopes(a: ApiKeyScope[], b: ApiKeyScope[]): boolean {
  if (a.length !== b.length) return false;
  const fingerprint = (s: ApiKeyScope) =>
    `${s.resource}:${s.id}:${[...s.permissions].sort().join(',')}`;
  const left = a.map(fingerprint).sort();
  const right = b.map(fingerprint).sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Which selection an existing key's scopes correspond to. A preset-minted key must reopen as that
 * preset, not sixteen custom checkboxes — otherwise every edit converts it to a custom key.
 */
export function presetForScopes(scopes: ApiKeyScope[] | null): ScopeSelection {
  if (!scopes || scopes.length === 0) return 'custom';
  for (const key of SCOPE_PRESET_KEYS) {
    if (sameScopes(scopes, SCOPE_PRESETS[key])) return key;
  }
  return 'custom';
}

interface Props {
  preset: ScopeSelection;
  onPresetChange: (preset: ScopeSelection) => void;
  customScopes: ApiKeyScope[];
  onCustomScopesChange: (scopes: ApiKeyScope[]) => void;
  disabled?: boolean;
}

export function ApiKeyScopeFields({
  preset,
  onPresetChange,
  customScopes,
  onCustomScopesChange,
  disabled = false,
}: Props) {
  // create and edit can both be mounted, so the scope select's id must be unique
  const scopeId = useId();

  function updateCustomScope(index: number, patch: Partial<ApiKeyScope>) {
    onCustomScopesChange(customScopes.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function togglePermission(index: number, permission: ApiKeyPermission) {
    onCustomScopesChange(
      customScopes.map((s, i) =>
        i === index
          ? {
              ...s,
              permissions: s.permissions.includes(permission)
                ? s.permissions.filter((p) => p !== permission)
                : [...s.permissions, permission],
            }
          : s,
      ),
    );
  }

  function addScope() {
    onCustomScopesChange([...customScopes, { resource: 'site', id: '*', permissions: ['read'] }]);
  }

  function removeScope(index: number) {
    onCustomScopesChange(customScopes.filter((_, i) => i !== index));
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={scopeId} className="text-white">scope</Label>
        <Select
          value={preset}
          onValueChange={(v) => {
            const next = v as ScopeSelection;
            const seeded = customScopesForSelection(next, preset, customScopes);
            if (seeded) onCustomScopesChange(seeded);
            onPresetChange(next);
          }}
          disabled={disabled}
        >
          <SelectTrigger id={scopeId} className="bg-background border-border text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_PRESET_KEYS.map((p) => (
              <SelectItem key={p} value={p}>
                {SCOPE_PRESET_LABELS[p]}
              </SelectItem>
            ))}
            <SelectItem value="custom">custom</SelectItem>
          </SelectContent>
        </Select>
        {preset !== 'custom' && (
          <p className="text-xs text-muted-foreground">{SCOPE_PRESET_DESCRIPTIONS[preset]}</p>
        )}
      </div>

      {preset === 'custom' && (
        <div className="space-y-2 rounded-md border border-border bg-card/40 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm leading-none font-medium text-white">custom scopes</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addScope}
              disabled={disabled}
              className="h-7 px-2 text-xs border-border cursor-pointer"
            >
              <Plus className="h-3 w-3 mr-1" /> add
            </Button>
          </div>
          {customScopes.map((s, i) => (
            <div
              key={i}
              /* Stacks below sm: at 390px a 110px select leaves ~180px for the id — too narrow. */
              className="grid grid-cols-1 sm:grid-cols-[110px_1fr_auto] gap-2 items-start rounded border border-border/50 bg-card/40 p-2"
            >
              <Select
                value={s.resource}
                onValueChange={(v) => updateCustomScope(i, { resource: v as ApiKeyResource })}
                disabled={disabled}
              >
                <SelectTrigger
                  aria-label={`scope ${i + 1} resource`}
                  className="h-8 text-xs bg-background border-border text-white"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <Input
                  type="text"
                  value={s.id}
                  onChange={(e) => updateCustomScope(i, { id: e.target.value })}
                  placeholder="id (or * for all)"
                  aria-label={`scope ${i + 1} id`}
                  className="h-8 text-base md:text-xs bg-background border-border text-white"
                  disabled={disabled}
                />
                <div role="group" aria-label={`scope ${i + 1} permissions`} className="flex flex-wrap gap-2">
                  {PERMISSIONS.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
                    >
                      <Checkbox
                        checked={s.permissions.includes(p)}
                        onCheckedChange={() => togglePermission(i, p)}
                        disabled={disabled}
                        className="h-3.5 w-3.5"
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <IconButton
                label={`remove scope ${i + 1}`}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeScope(i)}
                disabled={disabled || customScopes.length <= 1}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
