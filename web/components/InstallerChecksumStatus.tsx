'use client';

/**
 * Checksum status row rendered under an installer-URL input. Shows the
 * auto-compute spinner / resolved digest / error-with-retry, and the manual
 * entry fallback for URLs the web server cannot reach. State comes from
 * `useInstallerChecksum` so DeploymentDialog and SystemPresetDialog behave
 * identically.
 */

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InstallerChecksumState } from '@/hooks/useInstallerChecksum';

interface InstallerChecksumStatusProps {
  checksum: InstallerChecksumState;
  installerUrl: string;
}

export default function InstallerChecksumStatus({
  checksum,
  installerUrl,
}: InstallerChecksumStatusProps) {
  const {
    sha256Checksum,
    checksumStatus,
    checksumError,
    manualChecksum,
    computeChecksum,
    enterManualChecksum,
    exitManualChecksum,
    setManualChecksumValue,
  } = checksum;

  if (manualChecksum) {
    return (
      <div className="space-y-1">
        <Label htmlFor="manual-checksum" className="text-xs text-muted-foreground">
          sha256 checksum
        </Label>
        <Input
          id="manual-checksum"
          placeholder="64-character hex sha256 of the installer"
          value={sha256Checksum}
          onChange={(e) => setManualChecksumValue(e.target.value)}
          className="border-border bg-background text-foreground font-mono text-xs"
        />
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline cursor-pointer"
          onClick={exitManualChecksum}
        >
          compute automatically instead
        </button>
      </div>
    );
  }

  if (checksumStatus === 'computing') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        computing sha256 checksum…
        <button
          type="button"
          className="underline cursor-pointer hover:text-foreground"
          onClick={enterManualChecksum}
        >
          enter manually
        </button>
      </p>
    );
  }

  if (checksumStatus === 'ready') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
        <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
        sha256: {sha256Checksum.slice(0, 12)}…{sha256Checksum.slice(-8)}
      </p>
    );
  }

  if (checksumStatus === 'error') {
    return (
      <div className="flex items-start gap-1.5 text-xs text-warning">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          {checksumError || 'failed to compute checksum'}{' — '}
          <button
            type="button"
            className="underline cursor-pointer"
            onClick={() => {
              const url = installerUrl.trim();
              if (url) void computeChecksum(url);
            }}
          >
            retry
          </button>
          {' or '}
          <button
            type="button"
            className="underline cursor-pointer"
            onClick={enterManualChecksum}
          >
            enter manually
          </button>
        </span>
      </div>
    );
  }

  return null;
}
