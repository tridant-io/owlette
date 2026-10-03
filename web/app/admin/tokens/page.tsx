'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { formatSiteScopedTimestamp } from '@/lib/timeUtils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyRound, Trash2, RefreshCw, AlertTriangle, Clock, CheckCircle, Search, Layers, Eraser } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { AdminButton } from '@/components/admin/AdminButton';

interface TokenInfo {
  id: string;
  machineId: string;
  version: string;
  createdBy: string;
  createdAt: string | null;
  lastUsed: string | null;
  expiresAt: string | null;
  agentUid: string;
}

const ALL = 'all';

// tinted chips: light takes the family surface, dark keeps the 20% tints they always had
const CHIP = {
  success: 'border-success-border bg-success-surface text-success dark:bg-success/20',
  warning: 'border-warning-border bg-warning-surface text-warning dark:border-warning-solid/30 dark:bg-warning-solid/20',
  danger: 'border-danger-border bg-danger-surface text-danger dark:border-danger-solid/30 dark:bg-danger-solid/20',
  signal: 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan dark:bg-accent-cyan/20',
};

export default function TokensPage() {
  const { user, isSuperadmin, userSites, lastSiteId, updateLastSite, userPreferences } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isSuperadmin);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [prunableCount, setPrunableCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeAllDialogOpen, setRevokeAllDialogOpen] = useState(false);
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false);
  const [tokenToRevoke, setTokenToRevoke] = useState<TokenInfo | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isPruning, setIsPruning] = useState(false);

  const [search, setSearch] = useState('');
  const [versionFilter, setVersionFilter] = useState<string>(ALL);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);

  // Monotonic fetch counter: a slow older response must NOT overwrite a newer
  // site's data, or the table shows one site's tokens while the selector and the
  // revoke/prune actions target another — a way to nuke the wrong site.
  const fetchSeqRef = useRef(0);

  const fetchTokens = useCallback(async () => {
    if (!selectedSiteId) return;

    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/agent-tokens`, {
        cache: 'no-store',
      });
      const data = await response.json();

      if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch tokens');
      }

      setTokens(data.tokens);
      setPrunableCount(typeof data.prunableCount === 'number' ? data.prunableCount : 0);
    } catch (error: unknown) {
      if (seq !== fetchSeqRef.current) return; // don't surface a stale error
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to load tokens', {
        description: message,
      });
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [selectedSiteId]);

  useEffect(() => {
    if (selectedSiteId) {
      // Clear the previous site's rows up front so a FAILED fetch can't leave
      // stale data visible while revoke-all/prune target the newly selected site.
      setTokens([]);
      setPrunableCount(0);
      fetchTokens();
    } else {
      setTokens([]);
      setPrunableCount(0);
    }
  }, [selectedSiteId, fetchTokens]);

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setSelectedSiteId(savedSite);
      } else {
        setSelectedSiteId(sites[0].id);
      }
    }
  }, [sites, selectedSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    // Clear synchronously with the site change so the SAME render that flips the
    // selector also empties the table — the effect below clears too, but after
    // paint, leaving a frame where revoke-all / prune act on the old site's rows.
    setSelectedSiteId(siteId);
    setTokens([]);
    setPrunableCount(0);
    updateLastSite(siteId);
  };

  const handleRevokeToken = async () => {
    if (!tokenToRevoke) return;

    setIsRevoking(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/agent-tokens/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId: tokenToRevoke.id,  // Use unique token ID, not machineId
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke token');
      }

      toast.success('Token revoked', {
        description: `Token for ${tokenToRevoke.machineId} has been revoked.`,
      });

      fetchTokens();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to revoke token', {
        description: message,
      });
    } finally {
      setIsRevoking(false);
      setRevokeDialogOpen(false);
      setTokenToRevoke(null);
    }
  };

  const handleRevokeAll = async () => {
    setIsRevoking(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/agent-tokens/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          all: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke tokens');
      }

      toast.success('All tokens revoked', {
        description: `${data.revokedCount} token(s) have been revoked.`,
      });

      fetchTokens();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to revoke tokens', {
        description: message,
      });
    } finally {
      setIsRevoking(false);
      setRevokeAllDialogOpen(false);
    }
  };

  const handlePrune = async () => {
    setIsPruning(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/agent-tokens/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prune: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to prune tokens');
      }

      toast.success('dead tokens pruned', {
        description: `${data.revokedCount} superseded / expired token(s) removed. live tokens were untouched.`,
      });

      fetchTokens();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Failed to prune tokens', {
        description: message,
      });
    } finally {
      setIsPruning(false);
      setPruneDialogOpen(false);
    }
  };

  // Resolve the selected site's timezone for display-mode-aware rendering.
  // This is a site-scoped admin surface — there is no single "machine" anchor.
  const selectedSite = sites.find(s => s.id === selectedSiteId);
  const selectedSiteTimezone = selectedSite?.timezone;

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return formatSiteScopedTimestamp(
      dateStr,
      userPreferences.timeDisplayMode || 'machine',
      userPreferences.timezone,
      selectedSiteTimezone,
      userPreferences.timeFormat || '12h'
    );
  };

  const getExpiryStatus = (expiresAt: string | null) => {
    if (!expiresAt) {
      return { label: 'Never expires', color: CHIP.success };
    }
    const expiry = new Date(expiresAt);
    const now = new Date();
    if (expiry < now) {
      return { label: 'Expired', color: CHIP.danger };
    }
    const daysUntil = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 7) {
      return { label: `Expires in ${daysUntil}d`, color: CHIP.warning };
    }
    return { label: `Expires ${expiry.toLocaleDateString()}`, color: CHIP.signal };
  };

  // Distinct versions present, newest-first, for the version filter.
  const versions = useMemo(() => {
    const set = new Set<string>();
    tokens.forEach((t) => { if (t.version) set.add(t.version); });
    return Array.from(set).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }, [tokens]);

  // Per-machine token counts. More than one live token on a machineId means
  // either repeated re-pairs or distinct machines cloned to the same hostname.
  // We deliberately do NOT pick a winner: lastUsed is stamped at pairing time,
  // so a re-paired token can look freshest while the genuinely live one looks
  // stale — declaring one would invite revoking the live token, the exact
  // failure this surface exists to prevent. Flag the row; let a human decide.
  const machineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tokens) {
      counts.set(t.machineId, (counts.get(t.machineId) || 0) + 1);
    }
    return counts;
  }, [tokens]);

  const duplicateMachineCount = useMemo(
    () => Array.from(machineCounts.values()).filter((n) => n > 1).length,
    [machineCounts],
  );

  const filteredTokens = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tokens.filter((t) => {
      if (q && !t.machineId?.toLowerCase().includes(q) && !t.agentUid?.toLowerCase().includes(q)) {
        return false;
      }
      if (versionFilter !== ALL && t.version !== versionFilter) return false;
      if (duplicatesOnly && (machineCounts.get(t.machineId) || 0) <= 1) return false;
      return true;
    });
  }, [tokens, search, versionFilter, duplicatesOnly, machineCounts]);

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
      {/* Header with inline site selector */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">agent tokens</h1>
            <p className="text-muted-foreground">
              view and revoke agent authentication tokens
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Select value={selectedSiteId} onValueChange={handleSiteChange}>
              <SelectTrigger aria-label="site" className="w-[180px] bg-card border-border text-foreground">
                <SelectValue placeholder="select site" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted!">
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IconButton
              label="refresh tokens"
              variant="outline"
              onClick={fetchTokens}
              disabled={!selectedSiteId || loading}
              className="border-border text-foreground hover:bg-accent! hover:text-foreground!"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
            {tokens.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setRevokeAllDialogOpen(true)}
                className="cursor-pointer"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                revoke all
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Filter toolbar */}
      {selectedSiteId && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search machine id or agent uid"
              aria-label="search tokens"
              className="pl-9 bg-card border-border text-foreground"
            />
          </div>

          <Select value={versionFilter} onValueChange={setVersionFilter}>
            <SelectTrigger aria-label="agent version" className="w-[160px] bg-card border-border text-foreground">
              <SelectValue placeholder="all versions" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value={ALL} className="text-foreground hover:bg-muted!">all versions</SelectItem>
              {versions.map((v) => (
                <SelectItem key={v} value={v} className="text-foreground hover:bg-muted!">{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDuplicatesOnly((v) => !v)}
                aria-pressed={duplicatesOnly}
                className={`border-border cursor-pointer ${duplicatesOnly
                  ? 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/40 dark:hover:bg-accent-cyan/30!'
                  : 'text-foreground hover:bg-accent! hover:text-foreground!'}`}
              >
                <Layers className="h-4 w-4 mr-2" />
                duplicates{duplicateMachineCount > 0 ? ` (${duplicateMachineCount})` : ''}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>show only machine ids that have more than one live token — repeated re-pairs, or distinct machines cloned to the same hostname</p>
            </TooltipContent>
          </Tooltip>

          <div className="ml-auto flex items-center gap-3">
            {prunableCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPruneDialogOpen(true)}
                    className="border-warning-border text-warning hover:bg-warning-surface! hover:text-warning! cursor-pointer"
                  >
                    <Eraser className="h-4 w-4 mr-2" />
                    prune dead ({prunableCount})
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p>{prunableCount} superseded / expired token(s) are hidden here and safe to delete. live tokens are never touched.</p>
                </TooltipContent>
              </Tooltip>
            )}
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {filteredTokens.length === tokens.length
                ? `${tokens.length} live`
                : `${filteredTokens.length} of ${tokens.length} live`}
            </span>
          </div>
        </div>
      )}

      {/* Tokens Table */}
      {selectedSiteId && (
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">loading tokens...</div>
            ) : tokens.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <KeyRound className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>no active tokens for this site</p>
                <p className="text-sm mt-1">Tokens are created when agents register with the site</p>
              </div>
            ) : filteredTokens.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p>no tokens match your filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-card">
                      <TableHead className="text-foreground">machine ID</TableHead>
                      <TableHead className="text-foreground">version</TableHead>
                      <TableHead className="text-foreground">status</TableHead>
                      <TableHead className="text-foreground">created</TableHead>
                      <TableHead className="text-foreground">last used</TableHead>
                      <TableHead className="text-foreground text-right">actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTokens.map((token) => {
                      const expiryStatus = getExpiryStatus(token.expiresAt);
                      const dupCount = machineCounts.get(token.machineId) || 0;
                      const isDuplicated = dupCount > 1;
                      return (
                        <TableRow key={token.id} className="border-border hover:bg-muted/50">
                          <TableCell className="font-mono text-foreground">
                            <div className="flex items-center gap-2">
                              <span>{token.machineId}</span>
                              {isDuplicated && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      tabIndex={0}
                                      aria-label={`one of ${dupCount} tokens sharing machine id ${token.machineId}; revoking disconnects whichever agent holds this one`}
                                      className={`cursor-help ${CHIP.warning}`}
                                    >
                                      duplicate
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    <p>
                                      {dupCount} tokens share this machine id — repeated re-pairs, or separate machines cloned to the same hostname. compare &ldquo;last used&rdquo; before revoking; revoking disconnects whichever agent holds this token.
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-foreground">{token.version || 'N/A'}</TableCell>
                          <TableCell>
                            <Badge className={expiryStatus.color}>
                              {expiryStatus.label === 'Never expires' && <CheckCircle className="h-3 w-3 mr-1" />}
                              {expiryStatus.label.includes('Expires') && <Clock className="h-3 w-3 mr-1" />}
                              {expiryStatus.label === 'Expired' && <AlertTriangle className="h-3 w-3 mr-1" />}
                              {expiryStatus.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDate(token.createdAt)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDate(token.lastUsed)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setTokenToRevoke(token);
                                setRevokeDialogOpen(true);
                              }}
                              className="text-warning hover:text-warning! hover:bg-warning-surface!"
                            >
                              <KeyRound className="h-4 w-4 mr-1" />
                              revoke
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Revoke Single Token Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle>revoke token for {tokenToRevoke?.machineId}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will immediately invalidate the machine&apos;s authentication token.
              The agent will disconnect and cannot reconnect until re-registered with a new registration code.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AdminButton
              adminVariant="card"
              onClick={() => setRevokeDialogOpen(false)}
            >
              Cancel
            </AdminButton>
            <Button
              onClick={handleRevokeToken}
              disabled={isRevoking}
              className="bg-warning-solid text-warning-solid-foreground"
            >
              {isRevoking ? 'revoking...' : 'revoke token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke All Tokens Dialog */}
      <Dialog open={revokeAllDialogOpen} onOpenChange={setRevokeAllDialogOpen}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-danger">
              <AlertTriangle className="h-5 w-5" />
              revoke all tokens?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will immediately invalidate ALL agent tokens for this site ({tokens.length} tokens).
              All agents will disconnect and require re-registration to reconnect.
              <br /><br />
              <strong className="text-warning">this action cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AdminButton
              adminVariant="card"
              onClick={() => setRevokeAllDialogOpen(false)}
            >
              Cancel
            </AdminButton>
            <Button
              variant="destructive"
              onClick={handleRevokeAll}
              disabled={isRevoking}
            >
              {isRevoking ? 'revoking...' : `revoke all ${tokens.length} tokens`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Prune Dead Tokens Dialog */}
      <Dialog open={pruneDialogOpen} onOpenChange={setPruneDialogOpen}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <Eraser className="h-5 w-5" />
              prune dead tokens?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This removes {prunableCount} superseded and expired token(s) that agents can no longer use —
              the leftovers from refresh-token rotation. <strong className="text-foreground">live tokens are never touched</strong>,
              so no connected agent is affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AdminButton
              adminVariant="card"
              onClick={() => setPruneDialogOpen(false)}
            >
              Cancel
            </AdminButton>
            <Button
              onClick={handlePrune}
              disabled={isPruning}
              className="bg-warning-solid text-warning-solid-foreground"
            >
              {isPruning ? 'pruning...' : `prune ${prunableCount} dead tokens`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
