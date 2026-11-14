'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { getDoc, doc } from 'firebase/firestore';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/auth/AuthShell';
import { PairingReview } from '@/components/PairingReview';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDeviceCodeAuthorize } from '@/hooks/useDeviceCodeAuthorize';

interface Site {
  id: string;
  name: string;
}

export default function AddMachinePage() {
  const { user, loading: authLoading, isSuperadmin, userSites } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const {
    phrase: pairPhrase,
    setPhrase: setPairPhrase,
    review,
    lookUp,
    authorize,
    cancel,
    isAuthorizing,
    success: isAuthorized,
    authorizedMachineId: machineId,
  } = useDeviceCodeAuthorize(selectedSiteId);
  /**
   * Whether the selection was auto-made (single-site convenience) rather than
   * chosen. The first pass no longer races `role` — the fetch waits for
   * `userSites` to resolve — but the list can still change live under an
   * auto-selection (a membership granted or revoked), and a stale pick would
   * authorize against a site nobody chose. A deliberate choice is never withdrawn.
   */
  const autoSelectedRef = useRef(false);
  /**
   * The owlette server this page authorizes against. Rendered under the
   * description because it is the operator's only chance to notice they are on
   * dev while the machine is pairing with prod (or the reverse). Read after
   * mount so the server render and the first client render agree.
   */
  const [host, setHost] = useState('');

  // Pairing phrase arrives as ?code= when the agent auto-opens the browser.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setHost(window.location.host);
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setPairPhrase(code);
      }
    }
  }, [setPairPhrase]);

  useEffect(() => {
    async function fetchSites() {
      if (!user || !db) {
        setLoading(false);
        return;
      }
      // Access still resolving, and `isSuperadmin` with it: fetching now would
      // take the narrower membership branch for a superadmin. `loading` stays
      // up, and the effect re-runs when `userSites` lands.
      if (userSites === undefined) return;

      try {
        // `userSites` from AuthContext, NOT `users/{uid}.sites[]` read directly.
        // That field is legacy and wave 6.1 deletes it — reading it here would
        // have shown "no sites available. create a site on the dashboard first."
        // to every non-superadmin on the primary browser pairing flow, with no
        // error to explain it. AuthContext resolves the same list from the member
        // rows that actually grant access.
        const siteIds = isSuperadmin ? [] : userSites;
        const fetchedSites: Site[] = [];

        if (isSuperadmin) {
          // Superadmin sees every site, as on the setup page.
          const { collection, getDocs } = await import('firebase/firestore');
          const sitesRef = collection(db, 'sites');
          const sitesSnapshot = await getDocs(sitesRef);
          sitesSnapshot.forEach((doc) => {
            fetchedSites.push({ id: doc.id, ...doc.data() as Omit<Site, 'id'> });
          });
        } else {
          for (const siteId of siteIds) {
            try {
              const siteDoc = await getDoc(doc(db, 'sites', siteId));
              if (siteDoc.exists()) {
                fetchedSites.push({ id: siteDoc.id, ...siteDoc.data() as Omit<Site, 'id'> });
              }
            } catch {
              // Skip inaccessible sites.
            }
          }
        }

        setSites(fetchedSites);
        setSelectedSiteId((prev) => {
          // One choice — pick it, and record that we did.
          if (fetchedSites.length === 1) {
            autoSelectedRef.current = true;
            return fetchedSites[0].id;
          }
          // The list changed under an auto-selection: withdraw it.
          if (autoSelectedRef.current) {
            autoSelectedRef.current = false;
            return '';
          }
          // Keep a deliberate choice, unless the site is no longer offered.
          return prev && fetchedSites.some((s) => s.id === prev) ? prev : '';
        });
      } catch (error: unknown) {
        console.error('Error fetching sites:', error);
        toast.error('failed to load sites');
      } finally {
        setLoading(false);
      }
    }

    fetchSites();
  }, [user, isSuperadmin, userSites]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login?redirect=/add');
    }
  }, [authLoading, user, router]);

  const handleContinue = () => {
    if (!pairPhrase.trim()) {
      toast.error('please enter a pairing phrase');
      return;
    }
    if (!selectedSiteId) {
      toast.error('please select a site');
      return;
    }
    lookUp();
  };

  // Before the !user guard on purpose: the footer band below reads user.email.
  if (authLoading || loading) {
    return <AuthShell brandTitle="add machine" loading />;
  }

  if (!user) return null;

  if (isAuthorized) {
    return (
      /* Same shell as the form state — this used to be a third, narrower card
         geometry. */
      <AuthShell
        brandTitle="machine authorized"
        brandDescription="pairing complete"
      >
        <div className="space-y-6 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success/20">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
          <p className="text-muted-foreground">
            {machineId ? (
              <>
                <span className="break-all text-foreground">{machineId}</span> will
                appear on your dashboard shortly.
              </>
            ) : (
              'the machine will appear on your dashboard shortly.'
            )}
          </p>
          <Button
            onClick={() => router.push('/dashboard')}
            className="w-full cursor-pointer"
          >
            go to dashboard
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      brandTitle="add machine"
      brandDescription="enter the pairing phrase shown on your machine"
      brandMeta={host ? `authorizing on ${host}` : undefined}
      footer={<>logged in as <span className="break-all">{user.email}</span></>}
    >
      {/* Pairing Phrase Input */}
      <div className="space-y-2">
        <Label htmlFor="pair-phrase" className="text-foreground">pairing phrase</Label>
        <Input
          id="pair-phrase"
          placeholder="e.g., silver-compass-drift"
          value={pairPhrase}
          onChange={(e) => setPairPhrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && selectedSiteId && !review) handleContinue();
          }}
          className="bg-muted/50 border-border text-foreground placeholder:text-muted-foreground font-mono"
          autoFocus
          autoComplete="off"
        />
      </div>

      {/* Site Selection */}
      <div className="space-y-2">
        <Label htmlFor="site-select" className="text-foreground">site</Label>
        {sites.length > 0 ? (
          <Select value={selectedSiteId} onValueChange={setSelectedSiteId}>
            <SelectTrigger id="site-select" className="w-full bg-muted/50 border-border text-foreground">
              <SelectValue placeholder="choose a site..." />
            </SelectTrigger>
            <SelectContent className="bg-muted border-border">
              {sites.map((site) => (
                <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                  {site.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm text-muted-foreground">
            no sites available. create a site on the dashboard first.
          </p>
        )}
      </div>

      {/* The machine the phrase names, then the approval */}
      {review ? (
        <PairingReview
          review={review}
          busy={isAuthorizing}
          onAuthorize={authorize}
          onCancel={cancel}
          size="lg"
        />
      ) : (
        pairPhrase.trim() && selectedSiteId && (
          <Button
            onClick={handleContinue}
            disabled={isAuthorizing}
            className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            size="lg"
          >
            {isAuthorizing ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                looking up machine...
              </>
            ) : (
              'continue'
            )}
          </Button>
        )
      )}

    </AuthShell>
  );
}
