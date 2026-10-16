'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { CreateKeyInput } from '@/hooks/useApiKeys';
import {
  ApiKeyScopeFields,
  resolveScopes,
  type ScopeSelection,
  validateScopeSelection,
} from '@/components/ApiKeyScopeFields';
import {
  type ApiKeyScope,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
} from '@/lib/apiKeyTypes';

/**
 * The create-key form body: fields and actions, no heading or chrome.
 *
 * ApiKeysManager wraps it in a dialog that carries the title and the
 * shown-once warning, so the page and the account settings dialog (where it
 * opens as a nested modal) get the same form with ttl and custom scopes.
 */

interface Props {
  onSubmit: (input: CreateKeyInput) => Promise<void>;
  onCancel: () => void;
}

export function ApiKeyCreateForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState('');
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [preset, setPreset] = useState<ScopeSelection>('publisher');
  const [customScopes, setCustomScopes] = useState<ApiKeyScope[]>([
    { resource: 'site', id: '*', permissions: ['read', 'write'] },
  ]);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const validationError = validateScopeSelection(preset, customScopes);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }
    if (ttlDays < 1 || ttlDays > MAX_TTL_DAYS) {
      toast.error(`ttl must be between 1 and ${MAX_TTL_DAYS} days`);
      return;
    }

    setCreating(true);
    try {
      await onSubmit({
        name: name.trim(),
        scopes: resolveScopes(preset, customScopes),
        ttlDays,
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="keyName" className="text-foreground">
          name
        </Label>
        <Input
          id="keyName"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ci/cd — publisher"
          className="bg-background border-border text-foreground"
          disabled={creating}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ttlDays" className="text-foreground">
          ttl (days)
        </Label>
        <Input
          id="ttlDays"
          type="number"
          min={1}
          max={MAX_TTL_DAYS}
          value={ttlDays}
          onChange={(e) => setTtlDays(Number(e.target.value) || DEFAULT_TTL_DAYS)}
          className="bg-background border-border text-foreground"
          disabled={creating}
        />
      </div>

      <ApiKeyScopeFields
        preset={preset}
        onPresetChange={setPreset}
        customScopes={customScopes}
        onCustomScopesChange={setCustomScopes}
        disabled={creating}
      />

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={creating}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="button"
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="cursor-pointer"
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'create key'}
        </Button>
      </div>
    </div>
  );
}
