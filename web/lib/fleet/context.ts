/**
 * what a fleet route's handler is given once the request handler has verified
 * the session and the grant: who is calling, and what it may reach.
 */

import type { NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import type { Capability, MachineActor } from '@/lib/capabilities';
import type { FleetGrant } from '@/lib/fleet/policy.server';

export interface FleetContext {
  actor: MachineActor;
  siteId: string;
  /** the calling machine, never the machine a call acts on. */
  machineId: string;
  grant: FleetGrant;
  correlationId: string;
  db: Firestore;
}

/** one tool call dispatch has checked and is about to run. */
export interface FleetCallAdmission {
  /** what the tool's tier needs on the machine it names. */
  capability: Capability;
  tool: string;
  /** the machine the call acts on; null for a tool that names none. */
  machineId: string | null;
}

/**
 * the last step before a call runs, owned by the request handler: that
 * capability's rate limit and the blocking allow row. a response means refused.
 */
export type AdmitFleetCall = (admission: FleetCallAdmission) => Promise<NextResponse | null>;

/** a call dispatch refused itself, for the request handler's deny row. */
export interface FleetCallDenial {
  /** the problem's `code`. */
  reason: string;
  /** null when the caller named no tool. */
  tool: string | null;
  machineId: string | null;
}
