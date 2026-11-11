/**
 * what a fleet route's handler is given once the request handler has verified
 * the session and the grant: who is calling, and what it may reach.
 */

import type { NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import type { Capability, MachineActor } from '@/lib/capabilities';
import type { McpToolDefinition } from '@/lib/mcp-tools';
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

/** every item carries `text`, so a script that does not know a kind still shows words. */
export type FleetContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; text: string };

/** how a call the server answered itself ended. */
export type FleetAnswer =
  | { status: 'completed'; content: FleetContentItem[] }
  | { status: 'failed'; error: string };

/**
 * a tool the server answers itself, with no command to an agent. dispatch does
 * every check before `run`: a 'machine' tool acts on the one machine `machine`
 * names, which is in the site, inside the grant and has hoot on; a 'site' tool
 * names none, so it is a read and narrows what it returns to the grant itself.
 * `run` is handed only the parameters `definition` declares.
 */
export type FleetServerTool =
  | {
      target: 'site';
      definition: McpToolDefinition;
      run(ctx: FleetContext, params: Record<string, unknown>): Promise<FleetAnswer>;
    }
  | {
      target: 'machine';
      definition: McpToolDefinition;
      run(ctx: FleetContext, machine: string, params: Record<string, unknown>): Promise<FleetAnswer>;
    };
