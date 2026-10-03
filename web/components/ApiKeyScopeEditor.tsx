'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { UpdateKeyInput } from '@/hooks/useApiKeys';
import {
  ApiKeyScopeFields,
  presetForScopes,
  resolveScopes,
  type ScopeSelection,
  validateScopeSelection,
} from '@/components/ApiKeyScopeFields';
import type { ApiKeyListItem, ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * Edit a key's name and scopes in place, leaving the secret untouched.
 *
 * Revoke-and-recreate means updating every consumer just to widen one
 * permission, which is why under-scoped keys got replaced by over-broad ones;
 * rotation doesn't help, since it also hands out a new secret.
 *
 * ttl and environment are deliberately absent — the server rejects both on
 * PATCH (rotate extends expiry), so the fields would only produce a 400.
 */

interface Props {
  apiKey: ApiKeyListItem;
  onSubmit: (input: UpdateKeyInput) => Promise<void>;
  onCancel: () => void;
}

export function ApiKeyScopeEditor({ apiKey, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(apiKey.name || '');
  // Preset-minted keys reopen on their preset; everything else, including
  // legacy keys with no scopes, starts in the custom builder.
  const [preset, setPreset] = useState<ScopeSelection>(() => presetForScopes(apiKey.scopes));
  const [customScopes, setCustomScopes] = useState<ApiKeyScope[]>(() =>
    apiKey.scopes && apiKey.scopes.length > 0
      ? apiKey.scopes.map((s) => ({ ...s, permissions: [...s.permissions] }))
      : [{ resource: 'site', id: '*', permissions: ['read'] }],
  );
  const [saving, setSaving] = useState(false);
  // Pre-scoped-auth keys store no scopes and authenticate as full access, so
  // editing one is a narrowing, not an adjustment.
  const isLegacy = !apiKey.scopes || apiKey.scopes.length === 0;

  async function handleSave() {
    const validationError = validateScopeSelection(preset, customScopes);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }

    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        scopes: resolveScopes(preset, customScopes),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    /* Square top, no top border: this is the lower half of the row above, not
       a second card — a detached panel wouldn't say which key it edits. */
    <div className="space-y-4 rounded-md rounded-t-none border border-t-0 border-accent-cyan/50 bg-background/40 p-3">
      <h3 className="text-sm font-medium text-foreground">
        editing <span className="text-accent-cyan">{apiKey.name || '(unnamed key)'}</span>
      </h3>
      <p className="text-xs text-muted-foreground">
        the key itself does not change — anything already using{' '}
        <code className="font-mono">{apiKey.keyPrefix || 'owk_'}•••</code> keeps working with the
        new scopes on its next request.
      </p>

      {isLegacy && (
        <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            this is a legacy key with no scope list, which authenticates as full access. saving
            replaces that with exactly what you pick below — anything relying on it needs to be
            covered by these scopes.
          </span>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="editKeyName" className="text-foreground">
          name
        </Label>
        <Input
          id="editKeyName"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-background border-border text-foreground"
          disabled={saving}
        />
      </div>

      <ApiKeyScopeFields
        preset={preset}
        onPresetChange={setPreset}
        customScopes={customScopes}
        onCustomScopesChange={setCustomScopes}
        disabled={saving}
      />

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="cursor-pointer"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'save changes'}
        </Button>
      </div>
    </div>
  );
}
