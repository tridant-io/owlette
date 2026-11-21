/**
 * Mirrors `useRestartPresets:createPreset`: mint a preset id, write
 * `config/{siteId}/reboot_presets/{presetId}`, stamp `createdAt`.
 *
 * The `reboot_presets` collection and `reboot-` id prefix are wire contracts and
 * deliberately keep the legacy spelling; only UI and code identifiers say
 * "restart".
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { siteAuditActor } from './auditActor.server';

/** Mirrors web/hooks/useFirestore.ts:RestartScheduleEntry. */
export interface RestartScheduleEntryInput {
  id: string;       // crypto.randomUUID() at creation
  days: string[];   // e.g. ['mon','tue','wed','thu','fri']
  time: string;     // "HH:MM" 24h
}

export interface CreateRestartPresetInput {
  name: string;
  description?: string;
  /** Whether the schedule is active when this preset is applied. */
  enabled?: boolean;
  entries: RestartScheduleEntryInput[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
}

export interface CreateRestartPresetResult {
  presetId: string;
  siteId: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class RestartPresetValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'RestartPresetValidationError';
  }
}

export function validateRestartPresetInput(
  input: Partial<CreateRestartPresetInput>,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): void {
  if (!allowPartial || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new RestartPresetValidationError('name', 'name is required and must be a non-empty string');
    }
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new RestartPresetValidationError('description', 'description must be a string when provided');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new RestartPresetValidationError('enabled', 'enabled must be a boolean when provided');
  }
  if (!allowPartial || input.entries !== undefined) {
    if (!Array.isArray(input.entries)) {
      throw new RestartPresetValidationError('entries', 'entries must be an array');
    }
    for (let i = 0; i < input.entries.length; i++) {
      const entry = input.entries[i] as RestartScheduleEntryInput | undefined;
      if (!entry || typeof entry !== 'object') {
        throw new RestartPresetValidationError(`entries[${i}]`, 'entry must be an object');
      }
      if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
        throw new RestartPresetValidationError(`entries[${i}].id`, 'entry id must be a non-empty string');
      }
      if (!Array.isArray(entry.days) || entry.days.some((d) => typeof d !== 'string' || !VALID_DAYS.has(d))) {
        throw new RestartPresetValidationError(
          `entries[${i}].days`,
          'days must be a non-empty array of mon/tue/wed/thu/fri/sat/sun',
        );
      }
      if (typeof entry.time !== 'string' || !HHMM_RE.test(entry.time)) {
        throw new RestartPresetValidationError(`entries[${i}].time`, 'time must be HH:MM 24h');
      }
    }
  }
  if (!allowPartial || input.isBuiltIn !== undefined) {
    if (typeof input.isBuiltIn !== 'boolean') {
      throw new RestartPresetValidationError('isBuiltIn', 'isBuiltIn is required and must be a boolean');
    }
  }
  if (!allowPartial || input.order !== undefined) {
    if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
      throw new RestartPresetValidationError('order', 'order is required and must be a finite number');
    }
  }
  if (!allowPartial || input.createdBy !== undefined) {
    if (typeof input.createdBy !== 'string') {
      throw new RestartPresetValidationError('createdBy', 'createdBy is required and must be a string');
    }
  }
}

/**
 * Stored preset id format: `reboot-{slug}-{epochMs}` (kept for storage continuity).
 */
function generatePresetId(name: string): string {
  // capped so the id stays inside the 128 characters update and delete accept
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-|-$/g, '');
  return `reboot-${slug || 'preset'}-${Date.now()}`;
}

export async function createRestartPreset(
  ctx: SiteHandlerContext,
  input: CreateRestartPresetInput,
): Promise<CreateRestartPresetResult> {
  validateRestartPresetInput(input);

  const db = getAdminDb();
  const presetId = generatePresetId(input.name);
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('reboot_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    entries: input.entries,
    isBuiltIn: input.isBuiltIn,
    order: input.order,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.description !== undefined) payload.description = input.description;
  if (input.enabled !== undefined) payload.enabled = input.enabled;

  await presetRef.set(payload);

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: siteAuditActor(ctx),
    targetId: presetId,
    attributes: {
      verb: 'preset.create',
      endpoint: 'presets/reboot',
      method: 'POST',
      family: 'reboot',
      presetId,
      isBuiltIn: input.isBuiltIn,
    },
  });

  return { presetId, siteId: ctx.siteId };
}
