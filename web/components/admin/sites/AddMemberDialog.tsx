'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { isAccessValid, liveMachineIds } from '@/components/admin/sites/MachineAccessField';
import { MemberAccessFields, type SwoopChoice } from '@/components/admin/sites/MemberAccessFields';
import { MemberSearchInput, type AddMemberTarget } from '@/components/admin/sites/MemberSearchInput';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  SiteMemberApiError,
  useMemberCandidates,
  type AddableSiteMemberRole,
  type UseSiteMembersResult,
} from '@/hooks/useSiteMembers';
import { toast } from '@/lib/toast';

export function AddMemberDialog({
  siteId,
  membersMayWatch,
  machines,
  onOpenChange,
  addMember,
}: {
  siteId: string;
  membersMayWatch: boolean;
  machines: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  addMember: UseSiteMembersResult['addMember'];
}) {
  const { candidates, loading, error } = useMemberCandidates(siteId);
  const [target, setTarget] = useState<AddMemberTarget | null>(null);
  const [role, setRole] = useState<AddableSiteMemberRole>('member');
  const [swoop, setSwoop] = useState<SwoopChoice>('default');
  const [machineIds, setMachineIds] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const canAdd = !!target && isAccessValid(machineIds);

  const submit = async () => {
    if (!target || !canAdd || adding) return;
    setAdding(true);
    // by role sends no field, so the new row carries no swoop mode
    const swoopPart = swoop === 'default' ? {} : { swoop };
    // the whole site sends no field either
    const scopePart = machineIds === null ? {} : { machineIds: liveMachineIds(machineIds, machines) };
    const label = target.kind === 'uid' ? target.label : target.email;
    try {
      const added = await addMember(
        target.kind === 'uid'
          ? { uid: target.uid, role, ...swoopPart, ...scopePart }
          : { email: target.email, role, ...swoopPart, ...scopePart },
      );
      if (added.roleHonored) {
        toast.success('member added', { description: `${label} now has ${role} access to this site.` });
      } else {
        toast.info('already on this site', {
          description: `${label} was already a member, so nothing changed. change their access from their row.`,
        });
      }
      onOpenChange(false);
    } catch (err: unknown) {
      if (err instanceof SiteMemberApiError && err.status === 404) {
        toast.error('no account found for that email', {
          description: 'they need an owlette account before they can be added to a site.',
        });
      } else {
        toast.error('could not add member', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    // the members section mounts this only while open, so every open starts
    // empty and fetches the people it may offer afresh
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-accent-cyan" />
            add member
          </DialogTitle>
          <DialogDescription>give someone with an owlette account access to this site.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="add-member-query">name or email</Label>
            <MemberSearchInput
              id="add-member-query"
              describedBy="add-member-query-hint"
              candidates={candidates}
              loading={loading}
              error={error}
              disabled={adding}
              onTargetChange={setTarget}
              onSubmit={submit}
            />
            <p id="add-member-query-hint" className="text-xs text-muted-foreground">
              pick someone from your other sites, or type the full email they signed up with.
            </p>
          </div>
          <MemberAccessFields
            idPrefix="add-member"
            role={role}
            swoop={swoop}
            onRoleChange={setRole}
            onSwoopChange={setSwoop}
            membersMayWatch={membersMayWatch}
            machines={machines}
            machineIds={machineIds}
            onMachineIdsChange={setMachineIds}
            disabled={adding}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>
            cancel
          </Button>
          <Button onClick={submit} disabled={!canAdd || adding}>
            {adding ? (
              'adding…'
            ) : (
              <>
                <Plus />
                add member
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
