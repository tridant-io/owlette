/**
 * One-shot tier-3 approval ledger.
 *
 * An approval decision lives only in client React state until the resumed turn
 * persists it, so a reload (or second tab) during the approve→execute window can
 * re-present the approve button and dispatch the same tool twice. The ledger
 * makes consumption atomic: the first turn to resume an approved tool call
 * claims `chats/{chatId}/approvals/{toolCallId}` with a Firestore `create()`
 * (atomic ALREADY_EXISTS on conflict) BEFORE anything is dispatched; every
 * later turn sees `already-consumed` and rewrites the part to a terminal state
 * instead of executing (repairMessages.applyApprovalConsumption).
 *
 * Deliberately NOT built on lib/idempotency.ts — its read-before-save race
 * (OWL-07) is the exact bug class this ledger exists to close.
 *
 * Failure policy: a claim that errs indeterminately is retried once, then
 * reports 'claimed' (logged) so the turn goes on. It wrote no doc, though, and
 * dispatch runs a call only when this turn's claim is there to read
 * (`approvedCallMatches`), so a Firestore blip costs the call, not the rule.
 *
 * Docs are ~100 bytes, created only when a human approves a tier-3 tool, and
 * carry `expiresAt` for a future sweep; like `stream/current` they are
 * orphaned by client-side chat deletion (pre-existing, tracked in
 * dev/active/repo-cleanup-followups). No firestore.rules change: the
 * subcollection has no match block, so clients are default-denied.
 *
 * The card itself is recorded here too, at `chats/{chatId}/approvalRequests/
 * {toolCallId}`: what the model asked for, written in the step that produced the
 * call. It is the only thing that makes an approval real. Nothing a client sends
 * can create one, since `needsApproval` writes only for a call id that didn't
 * arrive in the incoming messages.
 *
 * Server-side only.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { sanitizeForLog } from '@/lib/logSanitize';

export type ApprovalClaim = 'claimed' | 'already-consumed';

/** Ledger docs become sweepable after 30 days — far beyond any turn's life. */
const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * How long a card can be answered. Long enough to come back to a follow-up that
 * fired overnight; a later answer just makes hoot ask again, and what a machine
 * should run yesterday isn't an answer about today.
 */
export const APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

function approvalRequestRef(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string,
): FirebaseFirestore.DocumentReference {
  return db.collection('chats').doc(chatId).collection('approvalRequests').doc(toolCallId);
}

export interface ApprovalRequest {
  toolName: string;
  inputHash: string;
  machineIds: string[];
}

/** Written when the model's own call raises a card. Throws, and the call then runs nothing. */
export async function recordApprovalRequest(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string,
  request: ApprovalRequest,
): Promise<void> {
  await approvalRequestRef(db, chatId, toolCallId).set({
    ...request,
    expiresAt: new Date(Date.now() + APPROVAL_REQUEST_TTL_MS),
  });
}

/** Whether a card was raised for this call. A failed read says no. */
export async function hasApprovalRequest(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string,
  toolName: string,
): Promise<boolean> {
  try {
    const request = await approvalRequestRef(db, chatId, toolCallId).get();
    return request.exists && request.data()?.toolName === toolName;
  } catch (error) {
    console.error(`[hoot] could not read approval request ${sanitizeForLog(toolCallId)}:`, error);
    return false;
  }
}

/** A stored expiry as firestore hands it back, or as a Date; anything else has none. */
function expiryMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: unknown } | null | undefined)?.toMillis;
  return typeof toMillis === 'function' ? (toMillis.call(value) as number) : null;
}

/**
 * Whether this turn may run this call: the card is still open and asked about
 * exactly this input, and this turn won its one claim. The machines may have narrowed since (one dropped off
 * while the card waited) and may not have grown. A failed read says no.
 */
export async function approvedCallMatches(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string | undefined,
  turnId: string | undefined,
  call: ApprovalRequest,
): Promise<boolean> {
  if (!toolCallId || !turnId) return false;
  try {
    const [request, claim] = await Promise.all([
      approvalRequestRef(db, chatId, toolCallId).get(),
      db.collection('chats').doc(chatId).collection('approvals').doc(toolCallId).get(),
    ]);
    const asked = request.data();
    const expires = expiryMillis(asked?.expiresAt);
    return (
      request.exists &&
      expires !== null &&
      expires > Date.now() &&
      asked?.toolName === call.toolName &&
      asked?.inputHash === call.inputHash &&
      Array.isArray(asked?.machineIds) &&
      call.machineIds.every((id) => asked.machineIds.includes(id)) &&
      claim.exists &&
      claim.data()?.turnId === turnId
    );
  } catch (error) {
    console.error(`[hoot] could not check approval ${sanitizeForLog(toolCallId)}:`, error);
    return false;
  }
}

/**
 * Atomically claim an approved tool call for execution by `turnId`.
 * 'claimed' → this turn owns the dispatch; 'already-consumed' → another turn
 * got there first and the caller must not execute.
 */
export async function claimApproval(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string,
  meta: { turnId: string },
): Promise<ApprovalClaim> {
  const ref = db
    .collection('chats')
    .doc(chatId)
    .collection('approvals')
    .doc(toolCallId);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ref.create({
        turnId: meta.turnId,
        claimedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + APPROVAL_TTL_MS),
      });
      return 'claimed';
    } catch (error) {
      if (isAlreadyExists(error)) return 'already-consumed';
      if (attempt === 1) {
        console.error(
          `[hoot] approval claim failed twice for chat ${sanitizeForLog(chatId)} tool ${sanitizeForLog(toolCallId)} — failing open:`,
          error,
        );
        return 'claimed';
      }
    }
  }
  // Unreachable; the loop always returns.
  return 'claimed';
}
