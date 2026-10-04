'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Link from 'next/link';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  SCOPE_PRESETS,
  type ApiKeyScopePreset,
} from '@/lib/apiKeyTypes';

const PRESETS: ApiKeyScopePreset[] = ['readonly', 'publisher', 'operator', 'admin'];

function CliAuthorizeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const code = (searchParams?.get('code') ?? '').toLowerCase().trim();
  const [name, setName] = useState('my cli');
  const [preset, setPreset] = useState<ApiKeyScopePreset>('publisher');
  const [ttlDays, setTtlDays] = useState(DEFAULT_TTL_DAYS);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const next = encodeURIComponent(`/cli/authorize?code=${code}`);
      router.push(`/login?redirect=${next}`);
    }
  }, [user, authLoading, router, code]);

  async function handleAuthorize() {
    if (!code) {
      toast.error('pairing phrase missing — re-run `roost auth login` in the cli');
      return;
    }
    if (!name.trim()) {
      toast.error('name is required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/cli/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          name: name.trim(),
          scopes: SCOPE_PRESETS[preset],
          ttlDays,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setDone(true);
        toast.success('cli authorised — return to your terminal');
      } else {
        toast.error(data.detail || data.error || 'authorisation failed');
      }
    } catch {
      toast.error('authorisation failed');
    }
    setSubmitting(false);
  }

  if (authLoading || !user) {
    return <AuthShell brandTitle="authorise cli" brandTitleAs="h1" loading />;
  }

  return (
    /* Same shell as /add, its sibling device-code flow. The PageHeader this page
       used to render was its only way out, so the footer band carries a link to
       the api keys page in its place. */
    <AuthShell
      brandTitle="authorise cli"
      brandTitleAs="h1"
      brandDescription="issue a scoped api key to the cli that requested this pairing phrase"
      footer={
        <>
          logged in as <span className="break-all">{user.email}</span>
          <span className="block pt-1">
            <Link href="/settings/api-keys" className={authFooterLinkClass}>
              manage api keys
            </Link>
          </span>
        </>
      }
    >
      {done ? (
        <div className="space-y-3 rounded-lg border border-success-border bg-success-surface p-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm text-foreground">cli authorised</p>
          <p className="text-xs text-muted-foreground">
            return to your terminal — the cli is polling and will pick up the key
            within a few seconds.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* items-start so the icon stays on the first line once the
              URL-supplied phrase wraps; min-w-0 + break-all so it wraps at all
              instead of setting the column's floor. */}
          <div className="flex items-start gap-2 rounded border border-warning-border bg-warning-surface p-3 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="min-w-0">
              pairing phrase:{' '}
              <code className="font-mono break-all">{code || '(missing)'}</code> — verify this
              matches what your cli printed.
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cliKeyName" className="text-foreground">
              key name
            </Label>
            <Input
              id="cliKeyName"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. laptop-dev, ci-runner"
              className="bg-background border-border text-foreground"
              disabled={submitting}
            />
          </div>

          {/* environment selector removed — every key is minted live; the
              server ignores an incoming `environment`. */}
          <div className="space-y-2">
            <Label htmlFor="cliTtlDays" className="text-foreground">
              ttl (days)
            </Label>
            <Input
              id="cliTtlDays"
              type="number"
              min={1}
              max={MAX_TTL_DAYS}
              value={ttlDays}
              onChange={(e) => setTtlDays(Number(e.target.value) || DEFAULT_TTL_DAYS)}
              className="bg-background border-border text-foreground"
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cliScopePreset" className="text-foreground">scope preset</Label>
            <Select
              value={preset}
              onValueChange={(v) => setPreset(v as ApiKeyScopePreset)}
              disabled={submitting}
            >
              <SelectTrigger id="cliScopePreset" className="w-full bg-background border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              use the settings → api keys page for fine-grained scope customisation.
            </p>
          </div>

          <Button
            type="button"
            onClick={handleAuthorize}
            disabled={submitting || !code || !name.trim()}
            className="w-full cursor-pointer"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'authorise'
            )}
          </Button>
        </div>
      )}
    </AuthShell>
  );
}

export default function CliAuthorizePage() {
  return (
    <Suspense fallback={<AuthShell brandTitle="authorise cli" loading />}>
      <CliAuthorizeInner />
    </Suspense>
  );
}
