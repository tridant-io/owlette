'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { SwoopSwitch } from '@/components/admin/sites/SiteSwitches';

export default function SwoopSettingsPage() {
  const { user, isSuperadmin, userSites, isSiteAdmin } = useAuth();
  const { sites, loading } = useSites(user?.uid, userSites, isSuperadmin);
  // the switch's route takes a whole-site owner or admin, so only their sites are listed
  const eligible = sites.filter((site) => isSiteAdmin(site.id));

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-4 md:mb-6"
          title="swoop settings"
          description="turn swoop on or off for each of your sites"
        />

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
      </div>
    </div>
  );
}
