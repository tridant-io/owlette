'use client';

import { useAuth } from '@/contexts/AuthContext';
import type { Site } from '@/hooks/useFirestore';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SwoopSwitch } from '@/components/admin/sites/SiteSwitches';

/** admin panel → swoop: a row per site the caller owns or administers, with its swoop switch. */
export function SwoopSiteTable({ sites, loading }: { sites: Site[]; loading: boolean }) {
  const { isSiteAdmin } = useAuth();
  // the switch's route takes a whole-site owner or admin, so only their sites are listed
  const eligible = sites.filter((site) => isSiteAdmin(site.id));

  return (
    <Card className="bg-card border-border py-3 md:py-6">
      <CardContent className="px-3 sm:px-6">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">loading sites...</div>
        ) : eligible.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">no sites you own or administer</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-card">
                <TableHead className="text-foreground">site</TableHead>
                <TableHead className="text-foreground text-right">swoop</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eligible.map((site) => (
                <TableRow key={site.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground whitespace-normal wrap-anywhere">{site.name}</TableCell>
                  <TableCell className="text-right">
                    <SwoopSwitch siteId={site.id} siteName={site.name} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
