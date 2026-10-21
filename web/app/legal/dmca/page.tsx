'use client';

/**
 * Public DMCA takedown form, capturing all six elements required by
 * 17 U.S.C. § 512(c)(3)(A). Email/postal notices reach the same
 * `dmca_notices` collection via admin entry; this is the preferred path.
 *
 * Decision logic: `web/lib/dmcaLogic.ts`. Rate-limiting + persistence:
 * `web/app/api/legal/dmca/route.ts`.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, Loader2, ScrollText } from 'lucide-react';

export default function DmcaFormPage() {
  const [state, setState] = useState<'draft' | 'submitting' | 'submitted' | 'error'>('draft');
  const [errorMessage, setErrorMessage] = useState<string>('');
  /** id of the field that failed validation — drives its aria-invalid outline. */
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<{
    id: string;
    elementsComplete: boolean;
    missing: string[];
  } | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setState('submitting');
    setErrorMessage('');
    const form = new FormData(e.currentTarget);

    // The form is noValidate (the native bubble is unstyleable), so the six
    // statutory elements are checked here. Marking the field invalid gives it
    // the red aria-invalid outline, and focusing it says which box.
    const REQUIRED: ReadonlyArray<readonly [string, string]> = [
      ['copyrightedWork', 'describe the copyrighted work being infringed'],
      ['identifiedMaterial', 'identify the material you claim is infringing'],
      ['name', 'enter your name'],
      ['email', 'enter your email address'],
      ['address', 'enter your address'],
      ['signature', 'type your full legal name as an electronic signature'],
    ];
    for (const [field, message] of REQUIRED) {
      if (!String(form.get(field) ?? '').trim()) {
        setInvalidField(field);
        setErrorMessage(message);
        setState('error');
        document.getElementById(field)?.focus();
        return;
      }
    }
    setInvalidField(null);

    const payload = {
      signature: form.get('signature'),
      copyrightedWork: form.get('copyrightedWork'),
      identifiedMaterial: form.get('identifiedMaterial'),
      complainant: {
        name: form.get('name'),
        email: form.get('email'),
        phone: form.get('phone') || undefined,
        address: form.get('address'),
      },
      goodFaithBelief: form.get('goodFaithBelief') === 'on',
      accuracyAndPerjuryAttestation: form.get('accuracyAndPerjuryAttestation') === 'on',
    };

    try {
      const res = await fetch('/api/legal/dmca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body?.detail ?? body?.title ?? `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const body = await res.json();
      setAcknowledgement({
        id: body.id,
        elementsComplete: Boolean(body.elementsComplete),
        missing: Array.isArray(body.missing) ? body.missing : [],
      });
      setState('submitted');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'submission failed');
      setState('error');
    }
  };

  if (state === 'submitted' && acknowledgement) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-sm font-medium">notice received</span>
            </div>
            <div className="text-sm text-muted-foreground">
              reference id:{' '}
              <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                {acknowledgement.id}
              </code>
            </div>
            {acknowledgement.elementsComplete ? (
              <p className="text-sm">
                your notice will be reviewed and acted on within 48 hours. you
                will receive an email update when the decision is made.
              </p>
            ) : (
              <Alert>
                <AlertDescription className="text-sm">
                  your notice is missing some required elements:{' '}
                  <code className="text-xs">{acknowledgement.missing.join(', ')}</code>
                  . our designated agent will contact you within 24 hours to
                  request the missing information.
                </AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">
              knowingly false statements in a DMCA notice may subject you to
              liability for damages under 17 U.S.C. § 512(f).
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-start gap-3">
        <ScrollText className="h-6 w-6 text-muted-foreground shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">dmca takedown notice</h1>
          <p className="text-sm text-muted-foreground">
            under 17 U.S.C. § 512(c), copyright owners may submit a notice
            requesting removal of infringing material. all six elements below
            are required by statute. knowingly false statements may subject
            you to liability for damages under § 512(f).
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1">
              <Label htmlFor="copyrightedWork">
                (1) the copyrighted work claimed to be infringed
              </Label>
              <Textarea
                id="copyrightedWork"
                name="copyrightedWork"
                aria-invalid={invalidField === 'copyrightedWork' || undefined}
                required
                rows={3}
                placeholder='e.g., "Neon Dreams" video installation, registered copyright TXu 2-123-456, created 2024'
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="identifiedMaterial">
                (2) the material you claim is infringing — url, path, or content id
              </Label>
              <Textarea
                id="identifiedMaterial"
                name="identifiedMaterial"
                aria-invalid={invalidField === 'identifiedMaterial' || undefined}
                required
                rows={3}
                placeholder="e.g., https://owlette.app/roosts/{roostId}, or the specific version id"
              />
              <p className="text-xs text-muted-foreground">
                be as specific as possible so our designated agent can locate
                the material without searching.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="name">(3) your name</Label>
                <Input id="name" name="name" required aria-invalid={invalidField === 'name' || undefined} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="email">email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  aria-invalid={invalidField === 'email' || undefined}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="phone">phone (optional)</Label>
                <Input id="phone" name="phone" type="tel" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="address">address</Label>
                <Input
                  id="address"
                  name="address"
                  required
                  aria-invalid={invalidField === 'address' || undefined}
                  placeholder="123 Studio Lane, City, State, ZIP"
                />
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox
                  name="goodFaithBelief"
                  required
                  className="mt-0.5"
                />
                <span>
                  (4) i have a good faith belief that the use of the material
                  identified above is not authorized by the copyright owner,
                  its agent, or the law.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox
                  name="accuracyAndPerjuryAttestation"
                  required
                  className="mt-0.5"
                />
                <span>
                  (5) i swear, under penalty of perjury, that the information
                  in this notification is accurate, and that i am the
                  copyright owner or authorized to act on behalf of the owner.
                </span>
              </label>
            </div>

            <div className="space-y-1">
              <Label htmlFor="signature">(6) electronic signature (type your full legal name)</Label>
              <Input id="signature" name="signature" required aria-invalid={invalidField === 'signature' || undefined} />
            </div>

            {state === 'error' && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={state === 'submitting'}>
                {state === 'submitting' ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    submitting…
                  </>
                ) : (
                  'submit notice'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        designated agent: pending registration at{' '}
        <a
          href="https://www.copyright.gov/dmca-directory/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          copyright.gov/dmca-directory
        </a>
        . for urgent matters, email our designated agent directly (address
        published on that directory once registered).
      </p>
    </main>
  );
}
