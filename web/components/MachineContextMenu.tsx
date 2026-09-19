'use client';

import { useState } from 'react';
import { MoreVertical, Trash2, KeyRound, RotateCcw, Power, Camera, Settings2, Eye, BellOff, Bell, XCircle, Monitor, MonitorPlay } from 'lucide-react';
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
   * installed. Swoop then replaces live view in the online block — exactly one
   * of the two renders. Whether this user may actually get a session is decided
   * server-side (site enablement, membersMayWatch, step-up), not here.
   */
  swoopCapable?: boolean;
  onSwoop?: () => void;
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
  onSwoop,
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
          description: `revoked ${revokedCount} token(s) for this hostname. affected agents must re-register to reconnect.`,
        });
      } else if (revokedCount > 0) {
        toast.success(`Token revoked for ${machineName}`, {
          description: 'revoked the most recently used token for this hostname; that agent must re-register to reconnect.',
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
                className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10 p-0 bg-card border border-border text-muted-foreground hover:text-white"
                onClick={(e) => {
                  // Prevent row click event from firing
                  e.stopPropagation();
                }}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p>machine options</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="border-border bg-secondary w-48">
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
                  className="text-red-400 focus:bg-red-950/30 focus:text-red-300 cursor-pointer"
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
                  className="text-red-400 focus:bg-red-950/30 focus:text-red-300 cursor-pointer"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  cancel shutdown
                </DropdownMenuItem>
              ) : (
                <>
                  <div className="flex items-center justify-between px-2 py-1.5 text-sm text-amber-400 rounded-sm hover:bg-amber-950/30 hover:text-amber-300">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowRestartDialog(true);
                      }}
                      data-testid="machine-context-menu-reboot"
                      className="flex-1 p-0 text-amber-400 focus:bg-transparent focus:text-amber-300 cursor-pointer"
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      restart machine
                    </DropdownMenuItem>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* Icon-only. Its "schedule restarts" label lives in the
                            tooltip portal, so `getByRole('button', { name:
                            'schedule restarts' })` cannot resolve it — that name
                            belongs to the standalone offline-machine item below
                            (`machine-context-menu-schedule-restarts`). */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowRestartScheduleDialog(true);
                          }}
                          data-testid="machine-context-menu-schedule-restarts-gear"
                          className="ml-2 p-0.5 rounded hover:bg-amber-950/50 transition-colors cursor-pointer"
                        >
                          <Settings2 className="h-3.5 w-3.5 text-muted-foreground hover:text-amber-300 transition-colors" />
                        </button>
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
                    className="text-orange-400 focus:bg-orange-950/30 focus:text-orange-300 cursor-pointer"
                  >
                    <Power className="mr-2 h-4 w-4" />
                    shutdown machine
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator className="bg-accent" />
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
                className="text-amber-400 focus:bg-amber-950/30 focus:text-amber-300 cursor-pointer"
              >
                <Settings2 className="mr-2 h-4 w-4" />
                schedule restarts
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-accent" />
            </>
          )}
          {isOnline && (
            <>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onScreenshot?.();
                }}
                className="text-sky-400 focus:bg-sky-950/30 focus:text-sky-300 cursor-pointer"
              >
                <Camera className="mr-2 h-4 w-4" />
                screenshot
              </DropdownMenuItem>
              {/* Swoop supersedes live view on a machine that can stream; the
                  slideshow stays for every agent that can't, so the menu never
                  loses its screen entry. */}
              {swoopCapable ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onSwoop?.();
                  }}
                  data-testid="machine-context-menu-swoop"
                  className="text-blue-400 focus:bg-blue-950/30 focus:text-blue-300 cursor-pointer"
                >
                  <MonitorPlay className="mr-2 h-4 w-4" />
                  swoop
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onLiveView?.();
                  }}
                  data-testid="machine-context-menu-live-view"
                  className="text-blue-400 focus:bg-blue-950/30 focus:text-blue-300 cursor-pointer"
                >
                  <Eye className="mr-2 h-4 w-4" />
                  live view
                </DropdownMenuItem>
              )}
            </>
          )}
          {onViewDisplays && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onViewDisplays();
              }}
              data-testid="machine-context-menu-view-displays"
              className="text-indigo-400 focus:bg-indigo-950/30 focus:text-indigo-300 cursor-pointer"
            >
              <Monitor className="mr-2 h-4 w-4" />
              view displays
            </DropdownMenuItem>
          )}
          {(isOnline || onViewDisplays) && (
            <DropdownMenuSeparator className="bg-accent" />
          )}
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              handleToggleMute();
            }}
            className="text-muted-foreground focus:bg-accent focus:text-white cursor-pointer"
          >
            {isMuted ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}
            {isMuted ? 'unmute alerts' : 'mute alerts'}
          </DropdownMenuItem>
          {isSiteAdmin && (
            <>
              <DropdownMenuSeparator className="bg-accent" />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRevokeDialog(true);
                }}
                data-testid="machine-context-menu-revoke-token"
                className="text-fuchsia-400 focus:bg-fuchsia-950/30 focus:text-fuchsia-300 cursor-pointer"
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
                className="text-red-400 focus:bg-red-950/30 focus:text-red-300 cursor-pointer"
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
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>revoke token for {machineName}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              revoking disconnects the agent, which must re-register to reconnect.
              <br /><br />
              if this hostname was re-paired, or if more than one machine shares it, there may be several tokens:
              <br />
              • <strong className="text-foreground">revoke current token</strong> — removes only the single most-recently-used token for this hostname.
              <br />
              • <strong className="text-red-400">revoke all for hostname</strong> — removes every token, disconnecting any other machine that shares this hostname too.
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
              className="bg-red-600 hover:bg-red-700"
            >
              {isRevoking && revokingScope === 'all' ? 'revoking...' : 'revoke all for hostname'}
            </Button>
            <Button
              onClick={() => handleRevokeToken('latest')}
              disabled={isRevoking}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isRevoking && revokingScope === 'latest' ? 'revoking...' : 'revoke current token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restart Confirmation Dialog */}
      <Dialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <DialogContent className="bg-card border-border">
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
              className="bg-red-600 hover:bg-red-700"
            >
              {isSendingCommand ? 'sending...' : 'restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shutdown Confirmation Dialog */}
      <Dialog open={showShutdownDialog} onOpenChange={setShowShutdownDialog}>
        <DialogContent className="bg-card border-border">
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
              className="bg-red-600 hover:bg-red-700"
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
