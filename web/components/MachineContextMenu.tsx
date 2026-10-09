'use client';

import { useState, useSyncExternalStore } from 'react';
import { MoreVertical, Trash2, KeyRound, RotateCcw, Power, Camera, Settings2, Eye, BellOff, Bell, XCircle, Monitor, MonitorPlay, MonitorOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import RestartScheduleDialog from '@/components/RestartScheduleDialog';
import type { RestartSchedule } from '@/hooks/useFirestore';
import { isThisMachine, subscribeThisMachine } from '@/lib/swoop/thisMachine';

interface MachineContextMenuProps {
  machineId: string;
  machineName: string;
  /** IANA timezone for this machine — RestartScheduleDialog renders its chip and
   * "next at" preview in the machine's local time, not the browser's. */
  machineTimezone?: string;
  siteId: string;
  isOnline: boolean;
  rebooting?: boolean;
  shuttingDown?: boolean;
  /**
   * Site-scoped admin gate. When false the menu hides every write action
   * (restart/shutdown/cancel, revoke token, remove machine) and keeps only the
   * user-scoped + read-only items. Contract:
   * dev/active/permission-model-split/manual-smoke-checklist.md.
   */
  isSiteAdmin?: boolean;
  onRemoveMachine: () => void;
  onRestart?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onCancelRestart?: () => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  /**
   * `capabilities.swoop === 1` from the heartbeat: the machine has a streamer
   * installed. Swoop then replaces live view in the online block, unless the
   * site has swoop off (`swoopOff`). Whether this user may actually get a
   * session is still decided server-side (site enablement, membersMayWatch,
   * step-up); `swoopOff` only stops the menu offering one the server refuses.
   */
  swoopCapable?: boolean;
  /**
   * live swoop viewers, mirrored onto the machine doc by the server from the
   * session records. counted on the swoop row and on the trigger only while the
   * machine is online, swoop-capable and its site has swoop on, so a stale
   * mirror never badges live view.
   */
  swoopViewers?: number;
  onSwoop?: () => void;
  /**
   * The site has swoop turned off, so a swoop-capable machine falls back to live
   * view. Admins get a way to the switch, and members learn who can flip it,
   * instead of a viewer the server refuses.
   */
  swoopOff?: boolean;
  /** Opens the site's editor, where the swoop switch lives. */
  onSiteSettings?: () => void;
  onViewDisplays?: () => void;
  rebootSchedule?: RestartSchedule;
}

export function MachineContextMenu({
  machineId,
  machineName,
  machineTimezone,
  siteId,
  isOnline,
  rebooting,
  shuttingDown,
  isSiteAdmin,
  onRemoveMachine,
  onRestart,
  onShutdown,
  onCancelRestart,
  onScreenshot,
  onLiveView,
  swoopCapable,
  swoopViewers,
  onSwoop,
  swoopOff,
  onSiteSettings,
  onViewDisplays,
  rebootSchedule,
}: MachineContextMenuProps) {
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showShutdownDialog, setShowShutdownDialog] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokingScope, setRevokingScope] = useState<'latest' | 'all' | null>(null);
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [showRestartScheduleDialog, setShowRestartScheduleDialog] = useState(false);
  const { userPreferences, updateUserPreferences } = useAuth();
  const isMuted = userPreferences.mutedMachines.includes(machineId);
  const watching = isOnline && swoopCapable && !swoopOff ? (swoopViewers ?? 0) : 0;
  // the machine this browser runs on, once its streamer has said so
  const onThisMachine = useSyncExternalStore(
    subscribeThisMachine,
    () => isThisMachine(siteId, machineId),
    () => false,
  );

  const handleToggleMute = async () => {
    const mutedMachines = isMuted
      ? userPreferences.mutedMachines.filter(id => id !== machineId)
      : [...userPreferences.mutedMachines, machineId];
    await updateUserPreferences({ mutedMachines }, { silent: true });
    toast.success(isMuted ? `Alerts unmuted for ${machineName}` : `Alerts muted for ${machineName}`, {
      description: isMuted ? 'You will receive alerts for this machine again.' : 'You will no longer receive email alerts for this machine.',
    });
  };

  // scope 'latest' revokes only this machine's most-recently-used token — safe
  // when several machines share a hostname; 'all' disconnects every sibling too.
  const handleRevokeToken = async (scope: 'latest' | 'all') => {
    setIsRevoking(true);
    setRevokingScope(scope);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/agent-tokens/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope === 'all' ? { machineId } : { machineId, latestOnly: true }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke token');
      }

      const revokedCount = data.revokedCount ?? 0;
      if (scope === 'all') {
        toast.success(`Tokens revoked for ${machineName}`, {
          description: `revoked ${revokedCount} token(s) for this hostname. the affected agents are leaving the site and must be paired again to reconnect.`,
        });
      } else if (revokedCount > 0) {
        toast.success(`Token revoked for ${machineName}`, {
          description: 'revoked the most recently used token for this hostname; that agent is leaving the site and must be paired again to reconnect.',
        });
      } else {
        toast.info(`No live token for ${machineName}`, {
          description: 'this hostname has no live token — nothing was revoked.',
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to revoke token', {
        description: message,
      });
    } finally {
      setIsRevoking(false);
      setRevokingScope(null);
      setShowRevokeDialog(false);
    }
  };

  const handleRestart = async () => {
    if (!onRestart) return;
    setIsSendingCommand(true);
    try {
      await onRestart();
      toast.success(`Restart command sent to ${machineName}`, {
        description: 'Restart starting. Click the countdown to cancel.',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to send restart command', { description: message });
    } finally {
      setIsSendingCommand(false);
      setShowRestartDialog(false);
    }
  };

  const handleShutdown = async () => {
    if (!onShutdown) return;
    setIsSendingCommand(true);
    try {
      await onShutdown();
      toast.success(`Shutdown command sent to ${machineName}`, {
        description: 'Shutdown starting. Click the countdown to cancel.',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to send shutdown command', { description: message });
    } finally {
      setIsSendingCommand(false);
      setShowShutdownDialog(false);
    }
  };

  const handleCancelRestart = async () => {
    if (!onCancelRestart) return;
    setIsSendingCommand(true);
    try {
      await onCancelRestart();
      toast.success(`Cancel sent to ${machineName}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to send cancel command', { description: message });
    } finally {
      setIsSendingCommand(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                data-testid="machine-context-menu-trigger"
                aria-label={`machine options for ${machineName}`}
                className="relative h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 bg-card border border-border text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  // Prevent row click event from firing
                  e.stopPropagation();
                }}
              >
                <MoreVertical className="h-4 w-4" />
                {/* aria-hidden: the trigger keeps its name; the swoop row
                    inside the menu carries the spoken count. */}
                {watching > 0 && (
                  <span
                    className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground pointer-events-none"
                    aria-hidden
                    data-testid="machine-context-menu-swoop-pill"
                  >
                    {watching}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p>machine options</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="border-border bg-raised w-52">
          {isOnline && isSiteAdmin && (
            <>
              {rebooting ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancelRestart();
                  }}
                  disabled={isSendingCommand}
                  data-testid="machine-context-menu-cancel-reboot"
                  className="text-danger focus:bg-danger-surface focus:text-danger cursor-pointer"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  cancel restart
                </DropdownMenuItem>
              ) : shuttingDown ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancelRestart();
                  }}
                  disabled={isSendingCommand}
                  data-testid="machine-context-menu-cancel-shutdown"
                  className="text-danger focus:bg-danger-surface focus:text-danger cursor-pointer"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  cancel shutdown
                </DropdownMenuItem>
              ) : (
                <>
                  {/* a split row: restart now, or schedule restarts. each half lights
                      on its own, with a hairline between, so it reads as two buttons */}
                  <div className="flex items-stretch gap-1">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowRestartDialog(true);
                      }}
                      data-testid="machine-context-menu-reboot"
                      className="flex-1 whitespace-nowrap text-warning focus:bg-warning-surface focus:text-warning cursor-pointer"
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      restart machine
                    </DropdownMenuItem>
                    <div aria-hidden className="my-1.5 w-px bg-border" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* A menu item, not a plain button: menu focus moves by
                            arrow key between items only, so a plain button here
                            was unreachable from the keyboard. */}
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowRestartScheduleDialog(true);
                          }}
                          aria-label="schedule restarts"
                          data-testid="machine-context-menu-schedule-restarts-gear"
                          className="w-8 justify-center px-0 text-muted-foreground focus:bg-warning-surface focus:text-warning cursor-pointer"
                        >
                          <Settings2 className="h-3.5 w-3.5 text-current" />
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>schedule restarts</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowShutdownDialog(true);
                    }}
                    data-testid="machine-context-menu-shutdown"
                    className="text-accent-warm-hover focus:bg-accent-warm/10 focus:text-accent-warm-hover cursor-pointer"
                  >
                    <Power className="mr-2 h-4 w-4" />
                    shutdown machine
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator className="bg-border" />
            </>
          )}
          {!isOnline && isSiteAdmin && (
            <>
              {/* Offline machines can still be scheduled: the restart schedule is
                  written to the config doc and the agent applies it from local
                  cache once it reconnects. The live restart/shutdown commands
                  above stay gated on `isOnline` because they need the agent up. */}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRestartScheduleDialog(true);
                }}
                data-testid="machine-context-menu-schedule-restarts"
                className="text-warning focus:bg-warning-surface focus:text-warning cursor-pointer"
              >
                <Settings2 className="mr-2 h-4 w-4" />
                schedule restarts
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
            </>
          )}
          {isOnline && (
            <>
              {/* Swoop supersedes live view on a machine that can stream; the
                  slideshow stays for every agent that can't, so the menu never
                  loses its screen entry. It leads: the live picture is the
                  entry people reach for, the still is the fallback. It alone
                  wears the brand colour, so the eye lands on it first. With
                  the site's swoop off, live view comes back and the swoop row
                  says how to turn it on. */}
              {swoopCapable && swoopOff && (isSiteAdmin ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onSiteSettings?.();
                  }}
                  data-testid="machine-context-menu-swoop-off"
                  className="text-primary font-medium focus:bg-primary/15 focus:text-primary cursor-pointer"
                >
                  <MonitorPlay className="mr-2 h-4 w-4" />
                  turn on swoop…
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled data-testid="machine-context-menu-swoop-off" className="items-start">
                  <MonitorOff className="mr-2 mt-0.5 h-4 w-4" />
                  <span className="flex flex-col">
                    swoop is off
                    <span className="text-xs text-muted-foreground">ask a site owner or admin to turn it on</span>
                  </span>
                </DropdownMenuItem>
              ))}
              {swoopCapable && !swoopOff ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!onThisMachine) onSwoop?.();
                  }}
                  disabled={onThisMachine}
                  data-testid="machine-context-menu-swoop"
                  className="text-primary font-medium focus:bg-primary/15 focus:text-primary cursor-pointer"
                >
                  <MonitorPlay className="mr-2 h-4 w-4" />
                  swoop
                  {onThisMachine && (
                    <span className="ml-auto text-xs font-normal text-muted-foreground">you&apos;re on this machine</span>
                  )}
                  {watching > 0 && (
                    <Badge className="ml-auto tabular-nums" data-testid="machine-context-menu-swoop-count">
                      {watching}
                      <span className="sr-only"> watching</span>
                    </Badge>
                  )}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onLiveView?.();
                  }}
                  data-testid="machine-context-menu-live-view"
                  className="text-info focus:bg-info-surface focus:text-info cursor-pointer"
                >
                  <Eye className="mr-2 h-4 w-4" />
                  live view
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onScreenshot?.();
                }}
                className="text-info focus:bg-info-surface focus:text-info cursor-pointer"
              >
                <Camera className="mr-2 h-4 w-4" />
                screenshot
              </DropdownMenuItem>
            </>
          )}
          {onViewDisplays && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onViewDisplays();
              }}
              data-testid="machine-context-menu-view-displays"
              className="text-[var(--series-display)] focus:bg-info-surface focus:text-[var(--series-display)] cursor-pointer"
            >
              <Monitor className="mr-2 h-4 w-4" />
              view displays
            </DropdownMenuItem>
          )}
          {(isOnline || onViewDisplays) && (
            <DropdownMenuSeparator className="bg-border" />
          )}
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              handleToggleMute();
            }}
            className="text-muted-foreground focus:bg-accent focus:text-foreground cursor-pointer"
          >
            {isMuted ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}
            {isMuted ? 'unmute alerts' : 'mute alerts'}
          </DropdownMenuItem>
          {isSiteAdmin && (
            <>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRevokeDialog(true);
                }}
                data-testid="machine-context-menu-revoke-token"
                className="text-danger focus:bg-danger-surface focus:text-danger cursor-pointer"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                revoke token
              </DropdownMenuItem>
              {/* No separator: revoking the token and removing the machine are
                  the same kind of act — they sever this machine from the site —
                  so they read as one destructive group. */}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveMachine();
                }}
                data-testid="machine-context-menu-remove"
                className="text-danger focus:bg-danger-surface focus:text-danger cursor-pointer"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                remove machine
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Revoke Token Dialog */}
      <Dialog open={showRevokeDialog} onOpenChange={setShowRevokeDialog}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle>revoke token for {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              revoking cuts the agent off: it leaves this site, drops its credentials and goes offline within a minute. to reconnect it must be paired again with a new phrase.
              <br /><br />
              if this hostname was re-paired, or if more than one machine shares it, there may be several tokens:
              <br />
              • <strong className="text-foreground">revoke current token</strong> — removes only the single most-recently-used token for this hostname.
              <br />
              • <strong className="text-danger">revoke all for hostname</strong> — removes every token, disconnecting any other machine that shares this hostname too.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => setShowRevokeDialog(false)}
              disabled={isRevoking}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={() => handleRevokeToken('all')}
              disabled={isRevoking}
              variant="destructive"
            >
              {isRevoking && revokingScope === 'all' ? 'revoking...' : 'revoke all for hostname'}
            </Button>
            <Button
              onClick={() => handleRevokeToken('latest')}
              disabled={isRevoking}
              className="bg-warning-solid text-warning-solid-foreground"
            >
              {isRevoking && revokingScope === 'latest' ? 'revoking...' : 'revoke current token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restart Confirmation Dialog */}
      <Dialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle>restart {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              this will restart the machine in 30 seconds. all running processes will be interrupted.
              you&apos;ll have 30 seconds to cancel from the dashboard.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowRestartDialog(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleRestart}
              disabled={isSendingCommand}
              variant="destructive"
            >
              {isSendingCommand ? 'sending...' : 'restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shutdown Confirmation Dialog */}
      <Dialog open={showShutdownDialog} onOpenChange={setShowShutdownDialog}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle>shutdown {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              this will shut down the machine in 30 seconds. the machine will not automatically restart.
              you&apos;ll have 30 seconds to cancel from the dashboard.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowShutdownDialog(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleShutdown}
              disabled={isSendingCommand}
              variant="destructive"
            >
              {isSendingCommand ? 'sending...' : 'shutdown'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restart Schedule Dialog */}
      <RestartScheduleDialog
        siteId={siteId}
        machineId={machineId}
        machineName={machineName}
        machineTimezone={machineTimezone}
        open={showRestartScheduleDialog}
        onOpenChange={setShowRestartScheduleDialog}
        currentSchedule={rebootSchedule}
      />
    </>
  );
}
