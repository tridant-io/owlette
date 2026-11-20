import type { MutationKind } from '@/lib/auditLogClient';

export type ActivityKind = 'change' | 'refused' | 'sign_in' | 'flagged';
export type ActivityView = 'all' | 'flagged' | 'changes' | 'refused' | 'sign-ins';

export interface ActivityActor {
  type: 'user' | 'api_key' | 'machine' | 'system' | 'unknown';
  id: string;            // uid, key id, machine id or system name
  label?: string;        // email for a user, filled by the route
}

export interface ActivityRow {
  id: string;            // `${source}:${docId}`, source = change | decision | platform | finding
  kind: ActivityKind;
  at: number;            // epoch ms
  actor: ActivityActor;
  subject?: ActivityActor; // the person a row is about when its actor is only the reporter
  siteId: string | null; // null = platform
  action: string;        // 'user_mutated:promoted', 'MACHINE_REMOVE', 'sign_in', a rule id
  outcome: 'allow' | 'deny' | 'error' | null;
  reason?: string;       // denyReason or errorCode
  target?: { kind?: string; id: string; machineId?: string };
  network?: { key: string; prefix: string | null };
  severity?: 'high' | 'digest';      // flagged only
  details: Record<string, unknown>;  // what the opened row shows
}

export type RuleId =
  | 'superadmin_promoted' | 'mfa_removed' | 'site_deleted' | 'second_factor_burst'
  | 'destructive_burst' | 'new_network_sign_in' | 'refusal_burst'
  | 'ownership_transferred' | 'user_deleted';

export interface Finding {
  id: string;            // deterministic, no '/'
  rule: RuleId;
  severity: 'high' | 'digest';
  title: string;         // lowercase, e.g. 'second factor burst'
  summary: string;       // one sentence
  subject: { userId?: string; actor?: string; siteId?: string | null };
  at: number;            // epoch ms of the newest row behind it
  facts: { label: string; value: string }[];
  rowIds: string[];
}

export const ACTIVITY_STATE_DOC = 'global/activity_watch';
export const ACTIVITY_FINDINGS_COLLECTION = `${ACTIVITY_STATE_DOC}/findings`;

// the feed takes at most this many users, and as many sites: each site is two more scans
// per page, and the users go to firestore as one `in`, which takes 30
export const MAX_FILTER_IDS = 10;

// every MutationKind; `api_key_used` is one row per api request and stays out of the feed
export const MUTATION_KINDS: readonly MutationKind[] = [
  'api_key_mutated',
  'chunk_mutated',
  'deployment_mutated',
  'distribution_mutated',
  'process_mutated',
  'roost_mutated',
  'machine_command_dispatched',
  'user_mutated',
  'site_mutated',
  'site_member_mutated',
  'installer_mutated',
  'webhook_mutated',
  'chat_mutated',
  'billing_mutated',
  'talon_mutated',
];

// a keep-alive, not something a person or machine did to anything. no longer recorded,
// but the rows written before that stay in the hash chains
export const ROUTINE_ACTIONS: ReadonlySet<string> = new Set(['site_mutated:fleet_session_minted']);

export const AUTH_CAPABILITIES = ['AUTH_SIGN_IN', 'AUTH_SECOND_FACTOR'] as const;
