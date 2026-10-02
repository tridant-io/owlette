'use client';

import { useState } from 'react';
import { AlertTriangle, Fingerprint, Pencil, Trash2, Plus, Check, X, Smartphone, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isMfaChallengeRequired, usePasskeys } from '@/hooks/usePasskeys';
import { LoadingWord } from '@/components/LoadingWord';
import { toast } from '@/lib/toast';

interface PasskeyManagerProps {
  userId: string;
  compact?: boolean;
  /**
   * Fired after register/delete so a parent showing the whole factor inventory
   * can re-read it — `usePasskeys` refreshes only its own rows, so the parent's
   * counts would otherwise go stale. Optional: /setup-2fa doesn't pass it.
   */
  onChange?: () => void;
  /**
   * Fired when the enrollment gate refuses registration (403
   * `mfa_challenge_required`), not the authenticator. The parent owns recovery
   * because the challenge covers every factor. Optional — the message is
   * toasted regardless, so nothing is swallowed.
   */
  onChallengeRequired?: () => void;
  /**
   * The account holds exactly one second factor overall. Passed in rather than
   * inferred from `passkeys.length` — only a parent sees the TOTP leg.
   *
   * Changes the remove-dialog copy and NOTHING else. Removing the last factor
   * is approved: the account re-arms `requiresMfaSetup`. Never make this
   * disable the button — a user must always be able to remove a credential
   * they no longer hold.
   */
  isLastFactor?: boolean;
}

export function PasskeyManager({
  userId,
  compact = false,
  onChange,
  onChallengeRequired,
  isLastFactor = false,
}: PasskeyManagerProps) {
  const {
    passkeys,
    loading,
    supported,
    registerPasskey,
    deletePasskey,
    renamePasskey,
  } = usePasskeys(userId);

  const [registering, setRegistering] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!supported) {
    return null;
  }

  const handleRegister = async () => {
    if (!showNameInput) {
      setShowNameInput(true);
      setNewPasskeyName('');
      return;
    }

    setRegistering(true);
    try {
      await registerPasskey(newPasskeyName || 'Passkey');
      toast.success('passkey registered successfully');
      setShowNameInput(false);
      setNewPasskeyName('');
      onChange?.();
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        toast.error('passkey registration was cancelled');
      } else {
        toast.error(err instanceof Error ? err.message : 'failed to register passkey');
        if (isMfaChallengeRequired(err)) {
          onChallengeRequired?.();
        }
      }
    } finally {
      setRegistering(false);
    }
  };

  const handleRename = async (credentialId: string) => {
    if (!editName.trim()) return;
    try {
      await renamePasskey(credentialId, editName.trim());
      setEditingId(null);
      toast.success('passkey renamed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to rename passkey');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePasskey(deleteTarget.id);
      toast.success('passkey removed');
      setDeleteTarget(null);
      onChange?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to delete passkey');
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getDeviceIcon = (deviceType: string) => {
    if (deviceType === 'multiDevice') return <Smartphone className="h-4 w-4 text-muted-foreground" />;
    return <Monitor className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <>
      <Card className={`bg-card/50 border-border ${compact ? '' : 'mt-4'}`}>
        <CardHeader className={compact ? 'pb-2' : ''}>
          <CardTitle className="text-foreground flex items-center gap-2 text-lg">
            <Fingerprint className="h-5 w-5 text-accent-cyan" />
            passkeys
          </CardTitle>
          {!compact && (
            <CardDescription className="text-muted-foreground">
              sign in faster with biometrics or your device PIN. passkeys replace both your password and 2FA.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground"><LoadingWord /></p>
          ) : (
            <>
              {passkeys.length === 0 && !showNameInput && (
                <p className="text-sm text-muted-foreground">no passkeys registered yet.</p>
              )}

              {passkeys.map((pk) => (
                <div
                  key={pk.credentialId}
                  className="flex items-center justify-between rounded-md border border-border bg-input/50 px-3 py-2"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {getDeviceIcon(pk.deviceType)}
                    <div className="min-w-0">
                      {editingId === pk.credentialId ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            aria-label="passkey name"
                            className="h-7 w-40 text-base md:text-sm bg-input border-border text-foreground"
                            maxLength={50}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(pk.credentialId);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                          />
                          <IconButton
                            label="save name"
                            variant="ghost"
                            className="h-7 w-7 cursor-pointer"
                            onClick={() => handleRename(pk.credentialId)}
                          >
                            <Check className="h-3.5 w-3.5 text-green-400" />
                          </IconButton>
                          <IconButton
                            label="cancel rename"
                            variant="ghost"
                            className="h-7 w-7 cursor-pointer"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="h-3.5 w-3.5 text-muted-foreground" />
                          </IconButton>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-foreground truncate">
                            {pk.friendlyName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            added {formatDate(pk.createdAt)}
                            {pk.backedUp && ' \u00b7 synced'}
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  {editingId !== pk.credentialId && (
                    <div className="flex items-center gap-1 shrink-0">
                      <IconButton
                        label={`rename ${pk.friendlyName}`}
                        variant="ghost"
                        className="h-7 w-7 cursor-pointer"
                        onClick={() => {
                          setEditingId(pk.credentialId);
                          setEditName(pk.friendlyName);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </IconButton>
                      <IconButton
                        label={`remove ${pk.friendlyName}`}
                        variant="ghost"
                        className="h-7 w-7 cursor-pointer"
                        onClick={() => setDeleteTarget({ id: pk.credentialId, name: pk.friendlyName })}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-400" />
                      </IconButton>
                    </div>
                  )}
                </div>
              ))}

              {showNameInput && (
                <div className="flex items-center gap-2">
                  <Input
                    value={newPasskeyName}
                    onChange={(e) => setNewPasskeyName(e.target.value)}
                    placeholder="passkey name (e.g. MacBook, iPhone)"
                    aria-label="new passkey name"
                    className="h-9 text-base md:text-sm bg-input border-border text-foreground placeholder:text-muted-foreground"
                    maxLength={50}
                    autoFocus
                    disabled={registering}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRegister();
                      if (e.key === 'Escape') setShowNameInput(false);
                    }}
                  />
                  <IconButton
                    label="cancel new passkey"
                    variant="ghost"
                    className="h-9 w-9 cursor-pointer"
                    onClick={() => setShowNameInput(false)}
                    disabled={registering}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </IconButton>
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full bg-input border-border text-foreground cursor-pointer"
                onClick={handleRegister}
                disabled={registering}
              >
                {registering ? (
                  'waiting for device...'
                ) : showNameInput ? (
                  <>
                    <Fingerprint className="mr-2 h-4 w-4" />
                    register passkey
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    add passkey
                  </>
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="border-border bg-secondary text-white sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">remove passkey</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to remove <span className="font-mono text-white">{deleteTarget?.name}</span>?
              you won&apos;t be able to sign in with this passkey anymore.
            </DialogDescription>
          </DialogHeader>
          {/* Warn, never block — removal is always allowed. */}
          {isLastFactor && passkeys.length === 1 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-xs text-amber-200">
                this is your last second factor — you&apos;ll be asked to set one up again
                next time you sign in.
              </p>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              className="bg-secondary border border-border cursor-pointer"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              className="cursor-pointer"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'removing...' : 'remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
