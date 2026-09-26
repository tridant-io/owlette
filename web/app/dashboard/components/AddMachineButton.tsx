'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Loader2, CheckCircle2, Copy, Monitor, Terminal, RefreshCw } from 'lucide-react';
import DownloadButton from '@/components/DownloadButton';
import { toast } from '@/lib/toast';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import { useDeviceCodeAuthorize } from '@/hooks/useDeviceCodeAuthorize';
import { serverFlagFor } from '@/lib/environment';

type AddMachineTab = 'enter' | 'generate';

interface AddMachineButtonProps {
  currentSiteId: string;
  currentSiteName?: string;
  /**
   * Hand the parent the modal's open/tab state. The zero-machine
   * "getting started" card uses it so its header "+" and its step-3 link open
   * the same modal on different tabs. Omit for a self-contained button.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  tab?: AddMachineTab;
  onTabChange?: (tab: AddMachineTab) => void;
}

export function AddMachineButton({
  currentSiteId,
  currentSiteName,
  open: controlledOpen,
  onOpenChange,
  tab: controlledTab,
  onTabChange,
}: AddMachineButtonProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [internalTab, setInternalTab] = useState<AddMachineTab>('enter');
  const { version } = useInstallerVersion();

  // Uncontrolled by default; controlled when the parent passes the props above.
  const open = controlledOpen ?? internalOpen;
  const tab = controlledTab ?? internalTab;
  const setOpen = (next: boolean) => (onOpenChange ?? setInternalOpen)(next);
  const setTab = (next: AddMachineTab) => (onTabChange ?? setInternalTab)(next);

  // Shared with the getting-started card's inline field via the hook, so the
  // authorize call has one implementation.
  const {
    phrase: enterPhrase,
    setPhrase: setEnterPhrase,
    authorize: handleAuthorize,
    isAuthorizing,
    success: enterSuccess,
    reset: resetEnter,
  } = useDeviceCodeAuthorize(currentSiteId);

  /**
   * The `/SERVER=` flag for the environment this dashboard *is*. Without it a
   * phrase minted on dev.owlette.app produces a command that installs against
   * production (the installer defaults to prod), the phrase is never found, and
   * the mistake travels to every machine the command is pasted into. One
   * expression feeds both the rendered command and the clipboard copy so the
   * two cannot diverge.
   */
  const serverFlag = typeof window === 'undefined' ? '' : serverFlagFor(window.location.host);

  // Generate Code tab state
  const [generatedPhrase, setGeneratedPhrase] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateSuccess, setGenerateSuccess] = useState(false);

  const resetState = () => {
    resetEnter();
    setGeneratedPhrase('');
    setIsGenerating(false);
    setGenerateSuccess(false);
    setTab('enter');
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetState();
  };

  // Generate Code: create a pre-authorized phrase for /ADD= bulk deploy
  const handleGenerate = async () => {
    if (!currentSiteId) return;

    setIsGenerating(true);
    try {
      // 1. mint a device code
      const codeResponse = await fetch('/api/agent/auth/device-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!codeResponse.ok) {
        throw new Error('Failed to generate pairing phrase');
      }

      const codeData = await codeResponse.json();
      const phrase = codeData.pairPhrase;

      // 2. authorize it for the current site
      const authResponse = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: phrase,
          siteId: currentSiteId,
        }),
      });

      if (!authResponse.ok) {
        const data = await authResponse.json();
        throw new Error(data.error || 'Failed to authorize phrase');
      }

      setGeneratedPhrase(phrase);
      setGenerateSuccess(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to generate code');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setTab('enter'); setOpen(true); }}
              className="text-muted-foreground cursor-pointer group"
            >
              <Plus className="h-4 w-4" />
              <span className="max-w-0 overflow-hidden group-hover:max-w-32 transition-all duration-200 ease-in-out whitespace-nowrap">
                &nbsp;add machine
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>add a new machine to this site</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">add machine</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {currentSiteName ? `adding to "${currentSiteName}"` : 'add a machine to the current site'}
            </DialogDescription>
          </DialogHeader>

          {/* Tab switcher */}
          <div className="relative grid grid-cols-2 rounded-lg bg-muted p-1">
            {/* Sliding indicator */}
            <div
              className="absolute rounded-md bg-background transition-transform duration-200 ease-in-out pointer-events-none"
              style={{
                top: '4px', bottom: '4px', left: '4px',
                width: 'calc(50% - 4px)',
                transform: tab === 'generate' ? 'translateX(100%)' : 'translateX(0)',
              }}
            />
            <button
              onClick={() => setTab('enter')}
              className={`relative z-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === 'enter' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              enter code
            </button>
            <button
              onClick={() => setTab('generate')}
              className={`relative z-10 rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === 'generate' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              generate code
            </button>
          </div>

          {/* Tab 1: Enter Code (for machines already showing a phrase) */}
          {tab === 'enter' && (
            <div className="space-y-5 mt-5">
              {enterSuccess ? (
                <div className="text-center space-y-4 py-4">
                  <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  </div>
                  <p className="text-foreground font-medium">machine authorized</p>
                  <p className="text-sm text-muted-foreground">
                    it will appear on your dashboard shortly.
                  </p>
                </div>
              ) : (
                <>
                  {/* Install instructions */}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground leading-snug">
                      1) install owlette on the target machine
                    </p>
                    <DownloadButton variant="inline" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      2) enter the 3-word phrase shown on the machine
                    </p>
                    <Input
                      placeholder="e.g., silver-compass-drift"
                      value={enterPhrase}
                      onChange={(e) => setEnterPhrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAuthorize();
                      }}
                      className="bg-muted/50 border-border text-foreground font-mono"
                      autoFocus
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    onClick={handleAuthorize}
                    disabled={!enterPhrase.trim() || isAuthorizing}
                    className="w-full text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAuthorizing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        authorizing...
                      </>
                    ) : (
                      <>
                        <Monitor className="h-4 w-4 mr-2" />
                        authorize
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Tab 2: Generate Code (for /ADD= bulk deploy) */}
          {tab === 'generate' && (
            <div className="space-y-4 mt-4">
              {generateSuccess && generatedPhrase ? (
                <div className="space-y-4">
                  <div className="text-center space-y-2">
                    <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                    </div>
                    <p className="text-foreground font-medium">code ready</p>
                  </div>

                  {/* Phrase with copy */}
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">pairing phrase</Label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 font-mono text-foreground">
                        {generatedPhrase}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(generatedPhrase, 'Phrase')}
                        aria-label="copy pairing phrase"
                        className="border-border text-foreground cursor-pointer shrink-0"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Command with copy */}
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">silent install command</Label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                        Owlette-Installer-v{version ?? '...'}.exe /ADD={generatedPhrase}{serverFlag} /SILENT
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(
                          `Owlette-Installer-v${version}.exe /ADD=${generatedPhrase}${serverFlag} /SILENT`,
                          'Command'
                        )}
                        aria-label="copy silent install command"
                        className="border-border text-foreground cursor-pointer shrink-0"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      silent install is windows only; on macos and linux pair from the app after installing
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      expires in 10 minutes
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setGenerateSuccess(false); setGeneratedPhrase(''); handleGenerate(); }}
                      className="text-muted-foreground cursor-pointer h-7 px-2 text-xs"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      regenerate
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-muted/30 border border-border rounded-lg p-4 space-y-2">
                    <div className="flex items-center gap-2 text-foreground font-medium text-sm">
                      <Terminal className="h-4 w-4 text-accent-cyan" />
                      bulk deployment
                    </div>
                    <p className="text-xs text-muted-foreground">
                      generate a pre-authorized pairing phrase. use it with the installer&apos;s
                      <code className="mx-1 px-1 py-0.5 bg-muted rounded text-foreground">/ADD=</code>
                      flag to silently add machines to this site.
                    </p>
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className="w-full text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        generating...
                      </>
                    ) : (
                      'generate code'
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
