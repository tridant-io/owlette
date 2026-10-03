'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { formatTimeOnly, getBrowserTimezone } from '@/lib/timeUtils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MonitorPlay, Power, RefreshCw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { AdminButton } from '@/components/admin/AdminButton';

/** One viewer, as `GET /api/sites/{siteId}/swoop/sessions` answers it. */
interface SwoopViewerInfo {
  uid: string;
  email: string | null;
  displayName: string | null;
  ctl: boolean;
  joinedAt: number;
}

interface SwoopSessionInfo {
  sid: string;
  machineId: string;
  state: 'pending' | 'live';
  startedAt: number;
  viewers: SwoopViewerInfo[];
}

/** A session with the site it was read from, which the kill route is addressed by. */
interface SessionRow extends SwoopSessionInfo {
  siteId: string;
  siteName: string;
}

interface ProblemBody {
  detail?: string;
  title?: string;
}

type SessionsResponse = ProblemBody & { data?: { sessions?: SwoopSessionInfo[] } };
type KillResponse = ProblemBody & { data?: { via?: 'signal' | 'command' } };

function problemMessage(body: ProblemBody | null, status: number): string {
  return body?.detail ?? body?.title ?? `request failed (${status})`;
}

/** `m:ss` under an hour, `h:mm:ss` from there. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export default function SwoopPage() {
  const { user, isSuperadmin, userSites, userPreferences } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isSuperadmin);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sessionToKill, setSessionToKill] = useState<SessionRow | null>(null);
  const [busy, setBusy] = useState(false);

  // a slow older round must not overwrite a newer one, or the table shows
  // sessions that a kill has already ended
  const fetchSeqRef = useRef(0);

  const fetchSessions = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    const results = await Promise.all(
      sites.map(async (site): Promise<{ rows: SessionRow[]; error?: string }> => {
        try {
          const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/swoop/sessions`, {
            cache: 'no-store',
          });
          // a site this user is only a member of: not theirs to see, and not an error
          if (response.status === 403) return { rows: [] };
          const body: SessionsResponse | null = await response.json().catch(() => null);
          if (!response.ok) return { rows: [], error: problemMessage(body, response.status) };
          const rows = (body?.data?.sessions ?? []).map((session) => ({
            ...session,
            siteId: site.id,
            siteName: site.name,
          }));
          return { rows };
        } catch (error: unknown) {
          return { rows: [], error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch

    setSessions(results.flatMap((result) => result.rows).sort((a, b) => a.startedAt - b.startedAt));
    setLoading(false);
    setLoaded(true);
    // one toast for the round, however many sites failed
    const error = results.find((result) => result.error)?.error;
    if (error) toast.error('could not load swoop sessions', { description: error });
  }, [sites]);

  useEffect(() => {
    // before the site list resolves, a round would ask no site and read as empty
    if (sitesLoading) return;
    void fetchSessions();
  }, [sitesLoading, fetchSessions]);

  // the duration column counts up
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleKill = async () => {
    if (!sessionToKill) return;
    const { siteId, machineId, sid } = sessionToKill;

    setBusy(true);
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/swoop/kill`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid }),
        },
      );
      const body: KillResponse | null = await response.json().catch(() => null);
      if (!response.ok) throw new Error(problemMessage(body, response.status));

      toast.success('session ended', {
        description: body?.data?.via === 'signal' ? 'delivered live' : 'queued for the machine',
      });
      void fetchSessions();
    } catch (error: unknown) {
      toast.error('could not end the session', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      setSessionToKill(null);
    }
  };

  const timezone = getBrowserTimezone();
  const timeFormat = userPreferences.timeFormat || '12h';

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">swoop</h1>
              <p className="text-muted-foreground">
                who is in a swoop session on your sites, and a way to end it
              </p>
            </div>
            <IconButton
              label="refresh sessions"
              variant="outline"
              onClick={() => void fetchSessions()}
              disabled={sitesLoading || loading}
              className="border-border text-foreground hover:bg-accent! hover:text-foreground!"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </div>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            {!loaded ? (
              <div className="text-center py-8 text-muted-foreground">loading sessions...</div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <MonitorPlay className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>no one is in a swoop session right now</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-card">
                      <TableHead className="text-foreground">machine</TableHead>
                      <TableHead className="text-foreground">site</TableHead>
                      <TableHead className="text-foreground">viewers</TableHead>
                      <TableHead className="text-foreground">state</TableHead>
                      <TableHead className="text-foreground">started</TableHead>
                      <TableHead className="text-foreground">duration</TableHead>
                      <TableHead className="text-foreground text-right">actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((session) => (
                      <TableRow key={`${session.siteId}/${session.sid}`} className="border-border hover:bg-muted/50">
                        <TableCell className="font-mono text-foreground">{session.machineId}</TableCell>
                        <TableCell className="text-foreground">{session.siteName}</TableCell>
                        <TableCell>
                          {session.viewers.length === 0 ? (
                            <span className="text-muted-foreground">none</span>
                          ) : (
                            <ul className="space-y-1">
                              {session.viewers.map((viewer, i) => (
                                <li key={`${viewer.uid}:${i}`} className="flex items-center gap-2 text-foreground">
                                  <span>{viewer.email || viewer.displayName || viewer.uid}</span>
                                  <Badge variant={viewer.ctl ? 'default' : 'secondary'}>
                                    {viewer.ctl ? 'control' : 'watch'}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                        </TableCell>
                        <TableCell className="text-foreground">{session.state}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatTimeOnly(session.startedAt / 1000, timezone, timeFormat)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm tabular-nums">
                          {formatDuration(now - session.startedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost-destructive"
                            size="sm"
                            onClick={() => setSessionToKill(session)}
                          >
                            <Power className="h-4 w-4" />
                            kill
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={sessionToKill !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setSessionToKill(null);
          }}
        >
          <DialogContent className="bg-background border-border">
            <DialogHeader>
              <DialogTitle>end this session?</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                the viewer is disconnected at once. this also closes every pending second-factor window on{' '}
                <span className="font-mono">{sessionToKill?.machineId}</span>.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <AdminButton adminVariant="card" onClick={() => setSessionToKill(null)} disabled={busy}>
                cancel
              </AdminButton>
              <Button variant="destructive" onClick={handleKill} disabled={busy}>
                {busy ? 'ending...' : 'end session'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
