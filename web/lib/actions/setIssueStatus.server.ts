/**
 * setIssueStatus action core: sets an issue's triage status and, when given, its
 * note, recording who changed it and when. Platform-level (`bug_reports`), NOT
 * site-scoped. `PATCH /api/admin/issues/{id}` validates the body and calls it.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import type { IssueStatus } from '@/lib/issues';
import { findIssue, serializeIssue, type Issue } from '@/lib/issues.server';

export interface SetIssueStatusContext {
  actor: UserActor;
  /** the issue number or its doc id */
  idOrNumber: string;
  status: IssueStatus;
  /** trimmed; undefined leaves the stored note alone */
  note?: string;
}

/** The updated issue, or null when there is no such issue. */
export async function setIssueStatus(ctx: SetIssueStatusContext): Promise<Issue | null> {
  const snap = await findIssue(getAdminDb(), ctx.idOrNumber);
  if (!snap) return null;

  await snap.ref.update({
    status: ctx.status,
    ...(ctx.note !== undefined ? { triageNote: ctx.note } : {}),
    statusUpdatedAt: FieldValue.serverTimestamp(),
    statusUpdatedBy: ctx.actor.userId,
  });

  return serializeIssue(await snap.ref.get());
}
