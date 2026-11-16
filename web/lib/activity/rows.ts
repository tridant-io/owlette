import { timestampToMs } from '@/lib/firestoreTime.server';
import { AUTH_CAPABILITIES, type ActivityActor, type ActivityRow } from './types';

type Doc = { id: string; data(): FirebaseFirestore.DocumentData | undefined };
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PLATFORM_SITE = '_platform';

export function parseChangeActor(actor: unknown): ActivityActor {
  const s = typeof actor === 'string' ? actor : '';
  const i = s.indexOf(':');
  const id = s.slice(i + 1);
  if (i > 0 && id) {
    const prefix = s.slice(0, i);
    if (prefix === 'user') return { type: 'user', id };
    if (prefix === 'apiKey') return { type: 'api_key', id };
    if (prefix === 'machine') return { type: 'machine', id };
    if (prefix === 'system') return { type: 'system', id };
    // a change hoot made for that user
    if (prefix === 'cortex' && id.startsWith('user_') && id.length > 5) return { type: 'user', id: id.slice(5) };
  }
  return { type: 'unknown', id: s };
}

export function fromChangeDoc(doc: Doc): ActivityRow {
  const data = (doc.data() ?? {}) as Data;
  const event = (data.event ?? {}) as Data;
  const attributes = (event.attributes ?? {}) as Data;
  const kind = String(event.kind ?? 'unknown');
  const verb = kind === 'machine_command_dispatched' ? attributes.commandType : attributes.verb;
  return {
    id: `change:${doc.id}`,
    kind: 'change',
    at: timestampToMs(data.recordedAt) ?? 0,
    actor: parseChangeActor(event.actor),
    siteId: !event.siteId || event.siteId === PLATFORM_SITE ? null : String(event.siteId),
    action: verb ? `${kind}:${verb}` : kind,
    outcome: null,
    ...(typeof event.target === 'string' ? { target: { id: event.target } } : {}),
    details: {
      ...attributes,
      ...(typeof event.actor === 'string' && event.actor.startsWith('cortex:') ? { via: 'hoot' } : {}),
      hash: data.hash ?? doc.id,
    },
  };
}

function decisionActor(actor: Data | undefined): ActivityActor {
  if (actor?.type === 'user') {
    return actor.apiKeyId
      ? { type: 'api_key', id: String(actor.apiKeyId) }
      : { type: 'user', id: String(actor.userId ?? '') };
  }
  if (actor?.type === 'machine') return { type: 'machine', id: String(actor.machineId ?? '') };
  if (actor?.type === 'system') return { type: 'system', id: String(actor.name ?? '') };
  return { type: 'unknown', id: '' };
}

export function isAuthCapability(capability: unknown): boolean {
  return (AUTH_CAPABILITIES as readonly unknown[]).includes(capability);
}

export function fromDecisionDoc(
  doc: Doc,
  source: 'decision' | 'platform',
  siteId: string | null,
): ActivityRow {
  const data = (doc.data() ?? {}) as Data;
  const metadata = (data.metadata ?? {}) as Data;
  const signIn = isAuthCapability(data.capability);
  const network = metadata.network as Data | undefined;
  const reason = data.denyReason ?? data.errorCode;
  const actor = decisionActor(data.actor);
  return {
    id: `${source}:${doc.id}`,
    kind: signIn ? 'sign_in' : 'refused',
    at: timestampToMs(data.timestamp) ?? 0,
    actor,
    ...(actor.type !== 'user' && typeof metadata.uid === 'string' && metadata.uid
      ? { subject: { type: 'user' as const, id: metadata.uid } }
      : {}),
    siteId,
    action: signIn
      ? data.capability === 'AUTH_SECOND_FACTOR' ? 'second_factor' : 'sign_in'
      : String(data.capability ?? ''),
    outcome: data.outcome ?? null,
    ...(reason ? { reason: String(reason) } : {}),
    ...(data.target?.id ? { target: data.target } : {}),
    ...(network?.key ? { network: { key: String(network.key), prefix: network.prefix ?? null } } : {}),
    details: {
      ...metadata,
      correlationId: data.correlationId,
      target: data.target,
      // the new-network rule weighs a superadmin sign-in higher
      ...(signIn && data.actor?.role ? { role: data.actor.role } : {}),
    },
  };
}

export function fromFindingDoc(doc: Doc): ActivityRow {
  const data = (doc.data() ?? {}) as Data;
  const subject = (data.subject ?? {}) as Data;
  const actor: ActivityActor = subject.actor
    ? parseChangeActor(subject.actor)
    : subject.userId
      ? { type: 'user', id: String(subject.userId) }
      : { type: 'unknown', id: '' };
  return {
    id: `finding:${doc.id}`,
    kind: 'flagged',
    // detectedAt, not the newest row's time: it is the field the feed orders and pages by
    at: timestampToMs(data.detectedAt) ?? 0,
    actor,
    siteId: subject.siteId ?? null,
    action: String(data.rule ?? ''),
    outcome: null,
    severity: data.severity,
    details: {
      title: data.title,
      summary: data.summary,
      facts: data.facts,
      rowIds: data.rowIds,
      subject,
      rowsAt: data.at,
      emailedAt: data.emailedAt ?? null,
      digestedAt: data.digestedAt ?? null,
    },
  };
}
