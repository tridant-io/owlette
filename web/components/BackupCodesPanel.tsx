'use client';

import { useRef, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface BackupCodesPanelProps {
  /** The plaintext sheet, in issue order. Shown once and never re-readable. */
  codes: string[];
  /** The account's email, written into the downloaded file. */
  account?: string | null;
  /** Heading above the sheet. Defaults to "save backup codes". */
  title?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** How long (ms) the copy button's check icon sticks. Defaults to 2000. */
  successDuration?: number;
}

/** The plain-text sheet `download codes` saves. */
function backupCodesFile(codes: string[], account?: string | null): string {
  return [
    'owlette two-factor authentication backup codes',
    `generated: ${new Date().toLocaleString()}`,
    ...(account ? [`account: ${account}`] : []),
    '',
    ...codes.map((code, i) => `${`${i + 1}.`.padEnd(4)}${code}`),
    '',
    'each code can be used only once. keep this file in a secure location.',
    '',
  ].join('\n');
}

/**
 * The shown-once backup-codes display. Purely presentational — takes the
 * plaintext sheet as a prop, fetches nothing — which is what lets one component
 * serve both issuance paths (`/setup-2fa` enrollment and account settings).
 *
 * The "only shown once" warning is load-bearing: the server stores hashes only,
 * so navigating away without saving means regenerating, which needs a factor
 * the user may no longer hold.
 */
export function BackupCodesPanel({
  codes,
  account,
  title = 'save backup codes',
  className,
  successDuration = 2000,
}: BackupCodesPanelProps) {
  const [copied, setCopied] = useState(false);
  // Track the latest timer: a second click before the first reset must not
  // leave the button stuck on "copied" when the new write fails.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopyAll() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      toast.success('copied to clipboard');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      // Denied permission, insecure context, or no clipboard API — say so
      // rather than imply the codes were saved.
      console.error('clipboard write failed:', err);
      toast.error('copy failed — select the codes and copy with Ctrl+C');
    }
  }

  function handleDownload() {
    // a data url, not a blob url: there is no object url to revoke, so no
    // revoke can race the download (safari cancels on an early revoke).
    const a = document.createElement('a');
    a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(backupCodesFile(codes, account))}`;
    a.download = 'owlette-backup-codes.txt';
    a.click();
  }

  return (
    <div className={cn('space-y-6', className)}>
      <div className="text-sm text-muted-foreground space-y-2">
        <p className="font-semibold text-destructive">{title}</p>
        <p>
          save these backup codes in a secure location. you can use them to access your account
          if you lose access to your authenticator app or passkey.
        </p>
        <p className="text-destructive font-semibold">these codes will only be shown once!</p>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        {/* Container-keyed, not viewport-keyed: this renders inside AuthShell's
            form column, whose width comes from the card's md: split. A
            `sm:grid-cols-2` here would put two 20-char mono codes in a 352px
            box at exactly the width where the card splits — and the card is
            overflow-hidden, so they would be clipped, not scrolled. */}
        <div className="grid grid-cols-1 @lg/auth-form:grid-cols-2 gap-2 font-mono text-sm">
          {codes.map((code, index) => (
            <div key={`${index}-${code}`} className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">{index + 1}.</span>
              <span className="font-bold break-all text-foreground">{code}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 @sm/auth-form:grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleCopyAll}
          aria-label={copied ? 'copied' : 'copy all codes'}
          className="w-full"
        >
          {copied ? <Check className="h-4 w-4 text-accent-cyan" /> : <Copy className="h-4 w-4" />}
          {copied ? 'copied' : 'copy all codes'}
        </Button>
        <Button type="button" variant="outline" onClick={handleDownload} className="w-full">
          <Download className="h-4 w-4" />
          download codes
        </Button>
      </div>
    </div>
  );
}
