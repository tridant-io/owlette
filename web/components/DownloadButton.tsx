'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Copy, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import {
  detectBrowserPlatform,
  INSTALLER_PLATFORMS,
  PLATFORM_LABEL,
  type BrowserPlatform,
  type InstallerPlatform,
} from '@/lib/installerPlatform';
import { toast } from '@/lib/toast';

interface DownloadButtonProps {
  /**
   * `card` spells the labels out; the header default and `inline` are
   * icon-only with tooltips — white on the dark header, muted in a dialog.
   */
  variant?: 'header' | 'card' | 'inline';
}

const HEADER_BUTTON = 'flex items-center hover:text-white cursor-pointer text-white p-1 sm:p-1.5 md:p-2';
const HEADER_ICON = 'h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4';
// the header is always dark; a dialog follows the theme, so its tips keep the default colours
const HEADER_TIP = 'bg-secondary border-border text-white';
const INLINE_BUTTON = 'text-muted-foreground cursor-pointer p-1.5';

// the os word a label uses: the first segment of the platform key
const osWord = (platform: InstallerPlatform) => platform.split('_')[0];

function Tip({ tip, className, children }: { tip: string; className?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className={className}>
        <p>{tip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Agent-installer download for the dashboard header, the getting-started card
 * and the add-machine dialog: the visitor's own platform is the primary action,
 * the menu lists the rest, copy takes the primary's link.
 */
export default function DownloadButton({ variant = 'header' }: DownloadButtonProps) {
  const { version, files, isLoading, error } = useInstallerVersion();
  const [browser, setBrowser] = useState<BrowserPlatform>({ platform: 'windows_x64', intelMac: false });

  useEffect(() => {
    let cancelled = false;
    detectBrowserPlatform(navigator).then((detected) => {
      if (!cancelled) setBrowser(detected);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // why a platform cannot be offered, or null when it can
  const unavailable = (platform: InstallerPlatform): string | null => {
    if (platform === 'macos_arm64' && browser.intelMac) return 'intel macs are not supported';
    if (!files[platform]) return `no ${osWord(platform)} build in this version`;
    return null;
  };

  const detected = browser.platform;
  const primary = unavailable(detected)
    ? (INSTALLER_PLATFORMS.find((platform) => !unavailable(platform)) ?? null)
    : detected;
  const primaryUrl = primary ? files[primary]?.download_url : undefined;

  const label = isLoading
    ? 'loading version info...'
    : primary
      ? `download v${version} for ${osWord(primary)}` +
        (primary === detected ? '' : ` (${unavailable(detected)})`)
      : 'no installer in this version';

  const download = (platform: InstallerPlatform) => {
    const url = files[platform]?.download_url;
    if (!url) {
      toast.error('download unavailable', {
        description: 'installer download URL is not available.',
      });
      return;
    }

    try {
      window.open(url, '_blank');
      toast.success('download started', {
        description: `downloading owlette v${version} for ${osWord(platform)}`,
      });
    } catch {
      toast.error('download failed', {
        description: 'failed to start download. please try again.',
      });
    }
  };

  const copyLink = async (platform: InstallerPlatform | null) => {
    const url = platform ? files[platform]?.download_url : undefined;
    if (!platform || !url) {
      toast.error('copy failed', {
        description: 'download URL is not available.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      toast.success('link copied', {
        description: `download link for v${version} (${osWord(platform)}) copied to clipboard.`,
      });
    } catch {
      toast.error('copy failed', {
        description: 'failed to copy link to clipboard.',
      });
    }
  };

  if (error || (!isLoading && !version)) {
    return null;
  }

  const header = variant === 'header';
  const iconOnly = variant !== 'card';
  const iconClass = header ? HEADER_ICON : 'h-4 w-4';
  const tipClass = header ? HEADER_TIP : undefined;
  const buttonProps = iconOnly
    ? ({ variant: 'ghost', size: 'sm' } as const)
    : ({ variant: 'default', size: 'default' } as const);
  const buttonClass = header ? HEADER_BUTTON : iconOnly ? INLINE_BUTTON : undefined;
  const disabled = isLoading || !primaryUrl;

  const primaryButton = (
    <Button
      {...buttonProps}
      className={iconOnly ? buttonClass : 'flex-1'}
      onClick={() => primary && download(primary)}
      disabled={disabled}
      aria-label={iconOnly ? 'download owlette agent' : undefined}
    >
      {isLoading ? (
        <Loader2 className={`${iconClass} animate-spin`} />
      ) : (
        <Download className={iconClass} />
      )}
      {!iconOnly && <span>{label}</span>}
    </Button>
  );

  const copyButton = (
    <Button
      {...buttonProps}
      className={buttonClass}
      onClick={() => copyLink(primary)}
      disabled={disabled}
      aria-label={iconOnly ? 'copy owlette agent download link' : undefined}
    >
      <Copy className={iconClass} />
      {!iconOnly && <span>copy link</span>}
    </Button>
  );

  return (
    <div
      className={
        header ? 'flex items-center gap-0.5 sm:gap-1' : iconOnly ? 'flex items-center gap-0.5 shrink-0' : 'flex gap-2'
      }
    >
      {iconOnly ? <Tip tip={label} className={tipClass}>{primaryButton}</Tip> : primaryButton}

      {iconOnly ? (
        <Tip tip={isLoading ? label : `copy download link for owlette agent v${version}`} className={tipClass}>
          {copyButton}
        </Tip>
      ) : (
        copyButton
      )}

      <DropdownMenu>
        <Tip tip="other platforms" className={tipClass}>
          <DropdownMenuTrigger asChild>
            <Button
              {...buttonProps}
              className={buttonClass}
              disabled={isLoading}
              aria-label="choose installer platform"
            >
              <ChevronDown className={iconClass} />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end">
          {INSTALLER_PLATFORMS.map((platform) => {
            const reason = unavailable(platform);
            const item = (
              <DropdownMenuItem
                key={platform}
                disabled={!!reason}
                onSelect={() => download(platform)}
                className="cursor-pointer gap-3"
              >
                <span className="flex-1">{PLATFORM_LABEL[platform]}</span>
                {/* a plain button: radix selects the row on a click that reaches it, so the copy stops there */}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-default"
                  disabled={!!reason}
                  aria-label={`copy ${osWord(platform)} download link`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyLink(platform);
                  }}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </DropdownMenuItem>
            );
            if (!reason) return item;
            return (
              <Tooltip key={platform}>
                {/* a disabled item takes no pointer events; the wrapper hovers for it */}
                <TooltipTrigger asChild>
                  <div>{item}</div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{reason}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
