'use client';

/**
 * `/talons` — automation list: trigger → condition → outputs, one row per talon, run history
 * behind each chevron. Page shell mirrors /roosts and /deployments so the site choice
 * behaves identically and follows the user to the next page.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Zap } from 'lucide-react';

import { PageCascade } from '@/components/PageCascade';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import DownloadButton from '@/components/DownloadButton';
import { FallingFeather } from '@/components/FallingFeather';
import { LoadingWord } from '@/components/LoadingWord';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines } from '@/hooks/useFirestore';
import { useCurrentSite } from '@/hooks/useCurrentSite';
import { useTalonPresets, type TalonPreset } from '@/hooks/useTalonPresets';
import { useTalons } from '@/hooks/useTalons';
import { findTalonPresetByName, talonPresetTemplateFrom } from '@/lib/talons/presetTemplate';
import { toast } from '@/lib/toast';

import { TALON_ROW_GRID, TalonCard } from './components/TalonCard';
import { TalonEditorDialog } from './components/TalonEditorDialog';

/** Derived from the list hook, not imported by name, so page/card/editor share one owner. */
type TalonListEntry = ReturnType<typeof useTalons>['talons'][number];

/** Custom presets sort after every built-in, as in every other preset family. */
const CUSTOM_TEMPLATE_ORDER = 100;

export default function TalonsPage() {
  const router = useRouter();
  const { user, loading: authLoading, isSiteAdmin } = useAuth();
  const {
    sites,
    sitesLoading,
    currentSiteId,
    createSite,
    updateSite,
    deleteSite,
    selectSite,
    pickSite,
  } = useCurrentSite();

  const { machines } = useMachines(currentSiteId);
  const { talons, loading: talonsLoading, error } = useTalons(currentSiteId);
  // One subscription for the whole list; rows raise "save as template" up here.
  const {
    presets: talonPresets,
    createPreset: createTalonPreset,
    updatePreset: updateTalonPreset,
  } = useTalonPresets(currentSiteId || null);

  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // The talon the editor is opened on. `null` = create mode.
  const [editingTalon, setEditingTalon] = useState<TalonListEntry | null>(null);
  // Set when "save as template" hit an existing template of the same name.
  const [pendingTemplate, setPendingTemplate] = useState<{
    talon: TalonListEntry;
    existing: TalonPreset;
  } | null>(null);

  const handleSiteChange = (siteId: string) => {
    selectSite(siteId);
  };

  const openCreate = () => {
    setEditingTalon(null);
    setEditorOpen(true);
  };

  const openEdit = (talon: TalonListEntry) => {
    setEditingTalon(talon);
    setEditorOpen(true);
  };

  /** `replace` is set only after the operator confirms a name collision — nothing overwrites
   * silently, and no preset family enforces name uniqueness server-side. */
  const writeTalonTemplate = async (talon: TalonListEntry, replace: TalonPreset | null) => {
    const description = talon.description?.trim();
    const template = talonPresetTemplateFrom(talon);
    try {
      if (replace) {
        await updateTalonPreset(replace.id, {
          name: talon.name,
          ...(description ? { description } : {}),
          template,
        });
      } else {
        await createTalonPreset({
          name: talon.name,
          ...(description ? { description } : {}),
          template,
          isBuiltIn: false,
          order: CUSTOM_TEMPLATE_ORDER,
          createdBy: '',
        });
      }
      toast.success('template saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to save template');
    }
  };

  const handleSaveAsTemplate = async (talon: TalonListEntry) => {
    // Checked against the MERGED list so built-in collisions count too; replacing one writes
    // the `builtin-*` override the api expects.
    const existing = findTalonPresetByName(talonPresets, talon.name);
    if (existing) {
      setPendingTemplate({ talon, existing });
      return;
    }
    await writeTalonTemplate(talon, null);
  };

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <FallingFeather />
        <p className="text-muted-foreground">
          <LoadingWord />
        </p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  // Loading branch runs BEFORE the no-sites card: an empty list pre-response is "unknown",
  // not "none", and rendering an empty state early flashes the wrong answer.
  const loading = sitesLoading || talonsLoading;

  return (
    <PageCascade className="relative min-h-screen pb-8">
      <PageHeader
        currentPage="Talons"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter((s) => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        onSiteCreated={(siteId) => pickSite(siteId)}
      />

      <AccountSettingsDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen} />

      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        <div className="mb-6 mt-3 flex flex-col gap-4 md:mt-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
              talons
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              automate the checks you would otherwise do by hand — a trigger, an optional look at
              the screen, and what should happen next.
            </p>
          </div>

          <Button
            type="button"
            data-testid="talon-create"
            onClick={openCreate}
            disabled={!currentSiteId}
            className="flex-shrink-0 cursor-pointer"
          >
            <Plus className="mr-2 h-4 w-4" />
            create talon
          </Button>
        </div>

        {/* Ahead of the loading branch: `loading` is derived from "the listener
            has not delivered this site yet", which a failed listener never
            does — checking it second would spin forever. */}
        {error ? (
          <Card className="border-border bg-card/50 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              failed to load talons — try refreshing the page.
            </p>
          </Card>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !currentSiteId ? (
          <Card className="border-border bg-card/50 p-8 text-center">
            <p className="text-sm text-foreground">no sites available</p>
            <p className="mt-1 text-xs text-muted-foreground">
              you need site access to manage talons. ask a site admin to add you.
            </p>
          </Card>
        ) : talons.length === 0 ? (
          // Compact on purpose: it sits where the list would and must not push the page down.
          <Card className="border-border bg-card/50 p-6 text-center">
            <Zap className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-foreground">no talons yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              a talon watches for something — a schedule, a threshold, an event — and acts on it.
            </p>
            <div className="mt-3 flex justify-center">
              <Button type="button" size="sm" onClick={openCreate} className="cursor-pointer">
                <Plus className="mr-1 h-3.5 w-3.5" />
                create talon
              </Button>
            </div>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {/* Shares `TALON_ROW_GRID` with every row below it — one column
                definition, so the labels sit over the values they name. Hidden
                below `md`, where rows fall back to the stacked layout and
                column headings would be meaningless. No sort control: talons
                are capped at 20 per site. */}
            <div
              className={`hidden border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground ${TALON_ROW_GRID}`}
            >
              <span aria-hidden="true" />
              <span className="truncate">name</span>
              <span className="truncate">trigger</span>
              <span className="hidden truncate lg:block">outputs</span>
              <span className="hidden truncate xl:block">scope</span>
              <span className="truncate">last run</span>
              <span aria-hidden="true" />
            </div>

            <div className="cascade-rows divide-y divide-border">
              {talons.map((talon) => (
                <TalonCard
                  key={talon.id}
                  talon={talon}
                  siteId={currentSiteId}
                  machines={machines}
                  onEdit={() => openEdit(talon)}
                  onSaveAsTemplate={() => handleSaveAsTemplate(talon)}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {currentSiteId && (
        <TalonEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          siteId={currentSiteId}
          machines={machines.map((m) => ({
            // machineId is both the doc key and the operator-visible label; the option wants both.
            id: m.machineId,
            name: m.machineId,
            online: m.online,
            processes: m.processes,
          }))}
          talon={editingTalon ?? undefined}
          isSiteAdmin={isSiteAdmin(currentSiteId)}
        />
      )}

      <ConfirmDialog
        open={pendingTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTemplate(null);
        }}
        title="replace template?"
        description={
          pendingTemplate
            ? `a template named "${pendingTemplate.existing.name}" already exists. replace it with this talon?`
            : ''
        }
        confirmText="replace"
        cancelText="cancel"
        onConfirm={() => {
          if (!pendingTemplate) return;
          const { talon, existing } = pendingTemplate;
          setPendingTemplate(null);
          void writeTalonTemplate(talon, existing);
        }}
      />
    </PageCascade>
  );
}
