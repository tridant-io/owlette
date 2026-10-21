'use client';

/**
 * Talon editor — trigger | condition | outputs. Create when `talon` is nullish
 * (POST), else edit (PATCH).
 *
 * Submits the SHARED validator's normalized `value`, never raw form state
 * (numbers are still strings, text un-trimmed). The same validator runs in
 * `@/lib/talons/store.server`, and server rejections arrive as RFC 7807
 * `fieldErrors` in the same `{ field, code, message }` shape, so client and
 * server misses bind identically.
 *
 * Error display invariants: (1) one place per message — `slotForField` maps a
 * path to at most one inline slot, everything else goes to the footer summary,
 * which skips already-slotted messages; (2) every draft setter drops the errors
 * bound to it so corrected fields stop showing stale messages.
 *
 * Templates are create-mode only and live in the dialog header (chrome, not a
 * field). Scope is never templated — machine ids belong to one site.
 *
 * Copy says "talons"/"hoot"; the wire type for a hoot output stays `'cortex'`.
 */

import { Loader2, Pencil, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import ConfirmDialog from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTalonPresets, type TalonPreset } from '@/hooks/useTalonPresets';
import { toast } from '@/lib/toast';
import {
  findTalonPresetByName,
  talonPresetTemplateFrom,
  type TalonPresetRequirement,
} from '@/lib/talons/presetTemplate';
import type { TalonDoc } from '@/lib/talons/types';
import {
  DEFAULT_TALON_COOLDOWN_MINUTES,
  TALON_DESCRIPTION_MAX_LENGTH,
  TALON_MAX_COOLDOWN_MINUTES,
  TALON_MIN_INTERVAL_MINUTES,
  TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK,
  TALON_NAME_MAX_LENGTH,
  validateTalonInput,
  type TalonFieldError,
  type TalonValidationResult,
} from '@/lib/talons/validation';

import {
  ConditionCard,
  conditionDraftFromTalon,
  conditionDraftToInput,
  newConditionDraft,
  newScopeDraft,
  scopeDraftFromTalon,
  scopeDraftToInput,
  type ConditionDraft,
  type ScopeDraft,
  type TalonMachineOption,
} from './ConditionCard';
import { OutputsCard, newOutputDraft, outputDraftFromTalon, outputDraftToInput, type OutputDraft } from './OutputsCard';
import { PipelineConnectors, PipelineStackConnector } from './PipelineConnectors';
import { TriggerCard, newTriggerDraft, triggerDraftFromTalon, triggerDraftToInput, type TriggerDraft } from './TriggerCard';
import { useScrollFade } from '@/hooks/useScrollFade';

/**
 * Validator field path → id of the input that owns it, so the caret can move to
 * the problem. Output paths carry a row index and are handled separately;
 * everything else walks up the path (`trigger.entries[0].time` →
 * `trigger.entries` → `trigger`) until it hits a mapped ancestor.
 */
const FIELD_ELEMENT_IDS: Readonly<Record<string, string>> = {
  name: 'talon-name',
  description: 'talon-description',
  trigger: 'talon-trigger-type',
  'trigger.type': 'talon-trigger-type',
  'trigger.entries': 'talon-trigger-entries',
  'trigger.intervalMinutes': 'talon-trigger-interval',
  'trigger.metric': 'talon-trigger-metric',
  'trigger.operator': 'talon-trigger-operator',
  'trigger.value': 'talon-trigger-value',
  'trigger.eventTypes': 'talon-trigger-events',
  'trigger.delayMinutes': 'talon-trigger-delay',
  condition: 'talon-condition-expectation',
  'condition.type': 'talon-condition-expectation',
  'condition.expectation': 'talon-condition-expectation',
  'condition.monitor': 'talon-condition-monitor',
  outputs: 'talon-outputs',
  scope: 'talon-scope',
  'scope.machineIds': 'talon-scope',
  cooldownMinutes: 'talon-cooldown',
};

const OUTPUT_FIELD_SUFFIXES: Readonly<Record<string, string>> = {
  url: 'url',
  directive: 'directive',
  commandType: 'command-type',
  processId: 'process',
  processName: 'process',
  type: 'type',
};

/** `outputs[2].url` → index 2, key `url`. */
const OUTPUT_FIELD_PATTERN = /^outputs\[(\d+)\]\.(\w+)$/;
/** `outputs[2]` — the row itself, from a non-object output. */
const OUTPUT_ROW_PATTERN = /^outputs\[(\d+)\]$/;
/** The three command keys share one message slot; the row shows one at a time. */
const OUTPUT_COMMAND_FIELDS: ReadonlySet<string> = new Set([
  'commandType',
  'processId',
  'processName',
]);

function elementIdForField(field: string): string {
  const outputMatch = OUTPUT_FIELD_PATTERN.exec(field);
  if (outputMatch) {
    const suffix = OUTPUT_FIELD_SUFFIXES[outputMatch[2]];
    if (suffix) return `talon-output-${outputMatch[1]}-${suffix}`;
    return 'talon-outputs';
  }

  let path = field.replace(/\[\d+\]/g, '');
  for (;;) {
    const mapped = FIELD_ELEMENT_IDS[path];
    if (mapped) return mapped;
    const cut = path.lastIndexOf('.');
    if (cut < 0) return '';
    path = path.slice(0, cut);
  }
}

/**
 * Inline slot for a validator path, or null when no control owns one.
 *
 * Matching is EXACT, never by prefix: prefix routing handed `outputs` the
 * `outputs[0].directive` message and printed it twice. Unslotted paths fall
 * through to the footer summary, so the two surfaces cover each error once.
 */
function slotForField(field: string): string | null {
  const output = OUTPUT_FIELD_PATTERN.exec(field);
  if (output) {
    const [, index, key] = output;
    if (key === 'url' || key === 'directive') return `outputs[${index}].${key}`;
    if (OUTPUT_COMMAND_FIELDS.has(key)) return `outputs[${index}].command`;
    // `type` has a select but no message slot of its own.
    return null;
  }
  if (field === 'outputs' || OUTPUT_ROW_PATTERN.test(field)) return 'outputs';
  if (field === 'name' || field === 'description' || field === 'cooldownMinutes') return field;
  if (field === 'trigger.entries' || field.startsWith('trigger.entries[')) return 'trigger.entries';
  if (field === 'trigger.eventTypes' || field.startsWith('trigger.eventTypes[')) {
    return 'trigger.eventTypes';
  }
  if (field === 'trigger.intervalMinutes') return 'trigger.intervalMinutes';
  // Safe: `triggerDraftToInput` only sends `delayMinutes` on the event form, so
  // the delay input is mounted whenever this error is reachable.
  if (field === 'trigger.delayMinutes') return 'trigger.delayMinutes';
  if (field === 'trigger.value') return 'trigger.value';
  if (field === 'condition.expectation') return 'condition.expectation';
  if (field === 'condition.monitor') return 'condition.monitor';
  if (field === 'scope' || field.startsWith('scope.')) return 'scope';
  return null;
}

/** Row index for any output-scoped path, or null for the list itself. */
function outputRowIndex(field: string): number | null {
  const match = /^outputs\[(\d+)\]/.exec(field);
  return match === null ? null : Number(match[1]);
}

/**
 * Move the caret to the first offender. Deferred a tick so it lands after the
 * re-render that applies `aria-invalid` — some browsers skip the announcement
 * otherwise. (`useFieldError.fail` is unusable here: it models one error with
 * one message, which duplicates the inline bindings.)
 */
function focusField(elementId: string): void {
  if (!elementId || typeof window === 'undefined') return;
  window.setTimeout(() => {
    const el = document.getElementById(elementId);
    if (el instanceof HTMLElement) el.focus();
  }, 0);
}

/** RFC 7807 body, narrowed to the members this dialog reads. */
interface TalonProblem {
  title?: string;
  detail?: string;
  fieldErrors?: TalonFieldError[];
}

function isFieldErrorList(value: unknown): value is TalonFieldError[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TalonFieldError).field === 'string' &&
        typeof (entry as TalonFieldError).message === 'string',
    )
  );
}

/**
 * What a template still needs from the operator. A talon spends the key of
 * whoever created it, and there is only one key (settings → hoot), so the copy
 * can name the exact screen that fixes it.
 */
const REQUIREMENT_LABELS: Readonly<Record<TalonPresetRequirement, string>> = {
  llm_key: 'needs an ai api key — add one in settings → hoot',
  process_target: 'needs a process to point at',
};

/**
 * Requirements this operator has NOT met — what is still missing, not a
 * permanent label on the template. `llm_key` is met once the user has a key;
 * `process_target` never is, since templates carry no process by design.
 *
 * `hasLlmKey === null` (probe failed/pending) counts as MET: never claim a
 * thing is missing on the strength of not having looked — the store's own
 * rejection names the same fix.
 */
function unmetRequirements(
  requires: readonly TalonPresetRequirement[],
  hasLlmKey: boolean | null,
): TalonPresetRequirement[] {
  return requires.filter(
    (requirement) => !(requirement === 'llm_key' && hasLlmKey !== false),
  );
}

/** Custom presets carry no requirements, so they always sort into "ready". */
const NO_REQUIREMENT_NOTE = '';

/**
 * Annotation under a template's name. Requirements annotate, never disable — a
 * greyed row with no explanation is worse discovery than a create-time message
 * naming the fix.
 */
function requirementNote(
  requires: readonly TalonPresetRequirement[],
  hasLlmKey: boolean | null,
): string {
  const unmet = unmetRequirements(requires, hasLlmKey);
  if (unmet.length === 0) return NO_REQUIREMENT_NOTE;
  return unmet.map((requirement) => REQUIREMENT_LABELS[requirement]).join(' · ');
}

/** Custom templates are created above every built-in's index, as in every family. */
const CUSTOM_TEMPLATE_ORDER = 100;

/** `crypto.randomUUID` needs a secure context; the fallback keeps http dev origins working. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `talon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}


interface TalonEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  machines: TalonMachineOption[];
  /** Null / undefined = create mode. */
  talon?: (TalonDoc & { id: string }) | null;
  isSiteAdmin?: boolean;
}

/**
 * Shell only. Radix unmounts `DialogContent` when closed, so the form is a
 * separate component whose `useState` initializers run fresh on every open —
 * no reset effect. The `key` covers swapping talons without closing.
 */
export function TalonEditorDialog({
  open,
  onOpenChange,
  siteId,
  machines,
  talon,
  isSiteAdmin = false,
}: TalonEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The base DialogContent carries `sm:max-w-lg`, which outranks a plain
          `max-w-*` at sm+ — width overrides must be breakpoint-qualified
          (see ManageSitesDialog for the same pattern). */}
      <DialogContent
        data-testid="talon-editor"
        className="border-border sm:max-w-5xl lg:max-w-6xl max-h-[90dvh] overflow-y-auto"
      >
        {/* Header renders inside the form — see the comment there. */}
        <TalonEditorForm
          key={talon?.id ?? 'new'}
          siteId={siteId}
          machines={machines}
          talon={talon ?? null}
          isSiteAdmin={isSiteAdmin}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface TalonEditorFormProps {
  siteId: string;
  machines: TalonMachineOption[];
  talon: (TalonDoc & { id: string }) | null;
  isSiteAdmin: boolean;
  onClose: () => void;
}

/**
 * The inline template form. `save` cuts a new template from the current draft;
 * `rename` only re-labels the selected one, leaving its stored talon alone.
 */
interface TemplateFormState {
  mode: 'save' | 'rename';
  name: string;
  description: string;
}

function TalonEditorForm({ siteId, machines, talon, isSiteAdmin, onClose }: TalonEditorFormProps) {
  // The form dissolves under the dialog header rather than being cut by it.
  const bodyRef = useScrollFade<HTMLDivElement>();

  const [name, setName] = useState(talon?.name ?? '');
  const [description, setDescription] = useState(talon?.description ?? '');
  const [trigger, setTrigger] = useState<TriggerDraft>(() =>
    talon ? triggerDraftFromTalon(talon.trigger) : newTriggerDraft(),
  );
  const [condition, setCondition] = useState<ConditionDraft>(() =>
    talon ? conditionDraftFromTalon(talon.condition) : newConditionDraft(),
  );
  const [scope, setScope] = useState<ScopeDraft>(() =>
    talon ? scopeDraftFromTalon(talon.scope) : newScopeDraft(),
  );
  const [outputs, setOutputs] = useState<OutputDraft[]>(() =>
    talon && talon.outputs.length > 0
      ? talon.outputs.map(outputDraftFromTalon)
      : [newOutputDraft('email')],
  );
  /** Raw text, as in `TriggerCard` — a half-typed number must not snap back. */
  const [cooldownValue, setCooldownValue] = useState(() =>
    String(talon?.cooldownMinutes ?? DEFAULT_TALON_COOLDOWN_MINUTES),
  );
  // Unrendered here (the list owns the toggle) but carried through every save:
  // PATCH replaces wholesale and an omitted `enabled` defaults to true, which
  // would silently re-arm a paused talon.
  const enabled = talon?.enabled ?? true;

  const [fieldErrors, setFieldErrors] = useState<TalonFieldError[]>([]);
  const [busy, setBusy] = useState(false);

  // Templates are create-mode only — silently replacing every field of a live
  // talon is not something a confirm dialog fixes. `null` keeps the listener
  // closed rather than subscribing for a row that never renders.
  const isCreate = talon === null;
  const {
    presets: templates,
    createPreset: createTemplate,
    updatePreset: updateTemplate,
    deletePreset: deleteTemplate,
  } = useTalonPresets(isCreate ? siteId : null);

  const [templateId, setTemplateId] = useState('');
  /** The inline name/description form — never a nested dialog. */
  const [templateForm, setTemplateForm] = useState<TemplateFormState | null>(null);
  /** Set when the chosen name already belongs to a template; drives the replace row. */
  const [pendingReplace, setPendingReplace] = useState<TalonPreset | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState(false);
  /** `null` = probe failed/pending; only `false` may claim a key is missing. */
  const [hasLlmKey, setHasLlmKey] = useState<boolean | null>(null);

  useEffect(() => {
    // The CURRENT USER's key — a talon created here runs on it. Session-scoped,
    // so members (not just admins) get an accurate answer.
    if (!isCreate) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/settings/llm-key');
        if (!response.ok) return;
        const body = (await response.json()) as { configured?: boolean };
        if (!cancelled) setHasLlmKey(body.configured === true);
      } catch {
        // Unknown — the picker keeps the generic note.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCreate]);

  const selectedTemplate = templates.find((preset) => preset.id === templateId) ?? null;
  // Built-ins are the shipped catalog — editing/deleting belongs on a
  // management page, not mid-authoring.
  const canManageSelected = selectedTemplate !== null && !selectedTemplate.isBuiltIn;
  const builtInTemplates = templates.filter((preset) => preset.isBuiltIn);
  // Grouped by what is MISSING for this operator, not by what the template
  // declares — with a key saved, every ai template is ready.
  const readyTemplates = builtInTemplates.filter(
    (preset) => unmetRequirements(preset.requires, hasLlmKey).length === 0,
  );
  const needsDetailTemplates = builtInTemplates.filter(
    (preset) => unmetRequirements(preset.requires, hasLlmKey).length > 0,
  );
  const savedTemplates = templates.filter((preset) => !preset.isBuiltIn);

  /**
   * Split errors into inline slots and the footer summary. Slots are first-wins;
   * the summary drops any message a slot already shows, so nothing appears twice.
   */
  const { slotMessages, summaryMessages } = useMemo(() => {
    const slots = new Map<string, string>();
    for (const entry of fieldErrors) {
      const slot = slotForField(entry.field);
      if (slot !== null && !slots.has(slot)) slots.set(slot, entry.message);
    }
    const shown = new Set(slots.values());
    const summary: string[] = [];
    for (const entry of fieldErrors) {
      if (slotForField(entry.field) !== null || shown.has(entry.message)) continue;
      shown.add(entry.message);
      summary.push(entry.message);
    }
    return { slotMessages: slots, summaryMessages: summary };
  }, [fieldErrors]);

  const errorFor = (slot: string): string | undefined => slotMessages.get(slot);

  /** Drop matching errors so a corrected control clears immediately, not at next submit. */
  function clearErrorsWhere(matches: (field: string) => boolean): void {
    setFieldErrors((prev) => {
      const next = prev.filter((entry) => !matches(entry.field));
      return next.length === prev.length ? prev : next;
    });
  }

  function handleNameChange(value: string): void {
    setName(value);
    clearErrorsWhere((field) => field === 'name');
  }

  function handleDescriptionChange(value: string): void {
    setDescription(value);
    clearErrorsWhere((field) => field === 'description');
  }

  function handleTriggerChange(next: TriggerDraft): void {
    setTrigger(next);
    clearErrorsWhere((field) => field === 'trigger' || field.startsWith('trigger.'));
  }

  function handleConditionChange(next: ConditionDraft): void {
    setCondition(next);
    // Interval floor depends on condition type — clear the stale floor message too.
    clearErrorsWhere(
      (field) =>
        field === 'condition' ||
        field.startsWith('condition.') ||
        field === 'trigger.intervalMinutes',
    );
  }

  function handleScopeChange(next: ScopeDraft): void {
    setScope(next);
    clearErrorsWhere((field) => field === 'scope' || field.startsWith('scope.'));
  }

  function handleOutputsChange(next: OutputDraft[]): void {
    // Add/remove/reorder shifts every output index, so unbind the whole set.
    const restructured =
      next.length !== outputs.length || next.some((draft, i) => draft.key !== outputs[i].key);
    setOutputs(next);
    clearErrorsWhere((field) => {
      if (!field.startsWith('outputs')) return false;
      if (restructured) return true;
      const index = outputRowIndex(field);
      // An in-place edit clears only the row whose draft object changed.
      return index !== null && next[index] !== outputs[index];
    });
  }

  function handleCooldownChange(value: string): void {
    setCooldownValue(value);
    clearErrorsWhere((field) => field === 'cooldownMinutes');
  }

  /** Bind a validator/server error list to the inputs, and focus the first offender. */
  function applyFieldErrors(errors: TalonFieldError[]): void {
    setFieldErrors(errors);
    focusField(elementIdForField(errors[0].field));
  }

  /**
   * Run the SHARED validator over the draft. Both save and "save as template"
   * go through it, so a template can never hold a talon create would refuse.
   * `''` becomes `NaN`, not 0 — the validator owns the message.
   */
  function validateDraft(): TalonValidationResult {
    const cooldown = cooldownValue.trim();
    return validateTalonInput({
      name,
      ...(description.trim() ? { description } : {}),
      enabled,
      trigger: triggerDraftToInput(trigger),
      condition: conditionDraftToInput(condition),
      outputs: outputs.map(outputDraftToInput),
      scope: scopeDraftToInput(scope),
      cooldownMinutes: cooldown === '' ? Number.NaN : Number(cooldown),
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setFieldErrors([]);

    const result = validateDraft();
    if (!result.ok) {
      applyFieldErrors(result.errors);
      return;
    }

    setBusy(true);
    try {
      const base = `/api/sites/${encodeURIComponent(siteId)}/talons`;
      const response = await fetch(talon ? `${base}/${encodeURIComponent(talon.id)}` : base, {
        method: talon ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json',
          // Create only — PATCH is already idempotent by replacement.
          ...(talon ? {} : { 'Idempotency-Key': newIdempotencyKey() }),
        },
        // The validator's normalized value, never the raw draft.
        body: JSON.stringify(result.value),
      });

      if (!response.ok) {
        let problem: TalonProblem = {};
        try {
          problem = (await response.json()) as TalonProblem;
        } catch {
          // Non-json error body (proxy, network layer) — fall through to the toast.
        }
        if (isFieldErrorList(problem.fieldErrors)) {
          applyFieldErrors(problem.fieldErrors);
        } else {
          toast.error(problem.detail ?? problem.title ?? `failed to save talon (${response.status})`);
        }
        setBusy(false);
        return;
      }

      toast.success(talon ? 'talon updated' : 'talon created');
      onClose();
    } catch {
      toast.error('failed to save talon');
      setBusy(false);
    }
  }

  /**
   * Replace the WHOLE draft with the template's talon. Scope is never templated
   * (machine ids belong to one site) so it resets to "all machines"; errors
   * bound to the replaced fields are dropped as stale.
   */
  function applyTemplate(presetId: string): void {
    setTemplateId(presetId);
    setTemplateForm(null);
    setPendingReplace(null);

    const preset = templates.find((candidate) => candidate.id === presetId);
    if (!preset) return;

    const { template } = preset;
    setName(template.name);
    setDescription(template.description ?? '');
    setTrigger(triggerDraftFromTalon(template.trigger));
    setCondition(conditionDraftFromTalon(template.condition));
    setScope(newScopeDraft());
    setOutputs(
      template.outputs.length > 0
        ? template.outputs.map(outputDraftFromTalon)
        : [newOutputDraft('email')],
    );
    setCooldownValue(String(template.cooldownMinutes));
    setFieldErrors([]);
  }

  /** Validate first — a template nobody can instantiate is worse than none. */
  function openSaveTemplate(): void {
    const result = validateDraft();
    if (!result.ok) {
      applyFieldErrors(result.errors);
      return;
    }
    setPendingReplace(null);
    setTemplateForm({
      mode: 'save',
      name: result.value.name,
      description: result.value.description ?? '',
    });
  }

  function openRenameTemplate(): void {
    if (!selectedTemplate) return;
    setPendingReplace(null);
    setTemplateForm({
      mode: 'rename',
      name: selectedTemplate.name,
      description: selectedTemplate.description ?? '',
    });
  }

  function closeTemplateForm(): void {
    setTemplateForm(null);
    setPendingReplace(null);
  }

  /** Cut a template from the current draft, creating or replacing one preset. */
  async function writeTemplate(
    templateName: string,
    templateDescription: string,
    replace: TalonPreset | null,
  ): Promise<void> {
    const result = validateDraft();
    if (!result.ok) {
      closeTemplateForm();
      applyFieldErrors(result.errors);
      return;
    }

    const template = talonPresetTemplateFrom(result.value);
    setTemplateBusy(true);
    try {
      if (replace) {
        await updateTemplate(replace.id, {
          name: templateName,
          ...(templateDescription ? { description: templateDescription } : {}),
          template,
        });
        setTemplateId(replace.id);
      } else {
        const presetId = await createTemplate({
          name: templateName,
          ...(templateDescription ? { description: templateDescription } : {}),
          template,
          isBuiltIn: false,
          order: CUSTOM_TEMPLATE_ORDER,
          createdBy: '',
        });
        setTemplateId(presetId);
      }
      toast.success('template saved');
      closeTemplateForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to save template');
    }
    setTemplateBusy(false);
  }

  async function submitTemplateForm(): Promise<void> {
    if (!templateForm || templateBusy) return;

    const trimmedName = templateForm.name.trim();
    const trimmedDescription = templateForm.description.trim();
    if (!trimmedName) {
      toast.error('give this template a name');
      return;
    }

    if (templateForm.mode === 'rename') {
      if (!selectedTemplate) return;
      setTemplateBusy(true);
      try {
        await updateTemplate(selectedTemplate.id, {
          name: trimmedName,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
        });
        toast.success('template renamed');
        closeTemplateForm();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'failed to rename template');
      }
      setTemplateBusy(false);
      return;
    }

    // Checked against the MERGED list so built-in collisions are caught too —
    // replacing one writes the `builtin-*` override.
    const existing = findTalonPresetByName(templates, trimmedName);
    if (existing) {
      setPendingReplace(existing);
      return;
    }
    await writeTemplate(trimmedName, trimmedDescription, null);
  }

  async function handleDeleteTemplate(): Promise<void> {
    if (!selectedTemplate) return;
    setTemplateBusy(true);
    try {
      await deleteTemplate(selectedTemplate.id);
      setTemplateId('');
      closeTemplateForm();
      toast.success('template deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to delete template');
    }
    setTemplateBusy(false);
  }

  const minIntervalMinutes =
    condition.type === 'visual_check'
      ? TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK
      : TALON_MIN_INTERVAL_MINUTES;

  // The process picker only offers processes from machines this talon can act on.
  const scopedMachines = scope.allMachines
    ? machines
    : machines.filter((machine) => scope.machineIds.includes(machine.id));

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* The header lives here rather than in the dialog shell so the template
          controls can sit beside the title without lifting their state out of
          this component. `pr-10` keeps the cluster clear of the dialog's own
          close button, which is absolutely positioned in the same corner. */}
      <DialogHeader className="pr-10">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <DialogTitle>{talon ? 'edit talon' : 'new talon'}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              a talon watches for something, checks a condition, then acts.
            </DialogDescription>
          </div>

          {/* Templates ride in the header: they are chrome for the form, not a
              field of it, and a full-width row at the top of the body read as
              the most important control on screen when it is the most optional
              one. Picker and save sit together so the disk icon is obviously
              "save THIS as one of those". */}
          {isCreate && (
            <div className="flex shrink-0 items-center gap-2">
              <Select value={templateId} onValueChange={applyTemplate} disabled={busy}>
                <SelectTrigger
                  id="talon-template"
                  data-testid="talon-template-picker"
                  aria-label="start from a template"
                  className="h-9 w-56 min-w-0 bg-background border-border"
                >
                  <SelectValue placeholder="start from a template…" />
                </SelectTrigger>
                <SelectContent>
                  {/* Built-ins split by whether they run as-is; saved templates
                      follow, ungrouped — a custom template has no shipped
                      requirements to sort it by. */}
                  {readyTemplates.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-muted-foreground">ready to use</SelectLabel>
                      {readyTemplates.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {needsDetailTemplates.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-muted-foreground">needs a detail</SelectLabel>
                      {needsDetailTemplates.map((preset) => (
                        <SelectItem
                          key={preset.id}
                          value={preset.id}
                          hint={requirementNote(preset.requires, hasLlmKey)}
                        >
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {savedTemplates.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-muted-foreground">saved</SelectLabel>
                      {savedTemplates.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>

              {/* Rename and delete belong to a saved template only — the shipped
                  catalog is managed elsewhere, not mid-authoring. */}
              {canManageSelected && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    data-testid="talon-template-rename"
                    onClick={openRenameTemplate}
                    disabled={busy || templateBusy}
                    aria-label="rename template"
                    title="rename template"
                    className="shrink-0 cursor-pointer border-border"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    data-testid="talon-template-delete"
                    onClick={() => setConfirmDeleteTemplate(true)}
                    disabled={busy || templateBusy}
                    aria-label="delete template"
                    title="delete template"
                    className="shrink-0 cursor-pointer border-border text-danger hover:bg-danger-surface hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}

              <Button
                type="button"
                variant="outline"
                size="icon"
                data-testid="talon-template-save"
                onClick={openSaveTemplate}
                disabled={busy || templateBusy}
                aria-label="save as template"
                title="save as template"
                className="shrink-0 cursor-pointer border-border"
              >
                <Save className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </DialogHeader>

      <div ref={bodyRef} className="max-h-[65vh] overflow-y-auto space-y-5 pr-1">
        {isCreate && (
          <div className="space-y-2">

            {/* Inline, and a `div` rather than a `form`: this sits INSIDE the
                talon form, where a nested form is invalid html and an enter
                keypress would submit the talon instead of the template. Enter
                is bound here explicitly for that reason. A nested dialog was
                the other option, and it would trap focus twice over one name
                and one sentence. */}
            {templateForm && (
              <div
                role="group"
                aria-label={templateForm.mode === 'rename' ? 'rename template' : 'save as template'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitTemplateForm();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeTemplateForm();
                  }
                }}
                className="rounded-lg border border-border bg-background/40 p-4 space-y-3"
              >
                {/* Labelled, not placeholder-only: two bare boxes side by side
                    gave no way to tell which was the name and which the
                    description once either had text in it. */}
                <p className="text-xs font-medium">
                  {templateForm.mode === 'rename' ? 'rename template' : 'save as template'}
                </p>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="space-y-1.5">
                    <Label htmlFor="talon-template-name" className="text-xs">
                      template name
                    </Label>
                    <Input
                      id="talon-template-name"
                      value={templateForm.name}
                      onChange={(e) =>
                        setTemplateForm({ ...templateForm, name: e.target.value })
                      }
                      disabled={templateBusy}
                      maxLength={TALON_NAME_MAX_LENGTH}
                      data-testid="talon-template-name"
                      placeholder="morning wall check"
                      autoFocus
                      className="h-9 bg-background border-border"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="talon-template-description" className="text-xs">
                      description <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="talon-template-description"
                      value={templateForm.description}
                      onChange={(e) =>
                        setTemplateForm({ ...templateForm, description: e.target.value })
                      }
                      disabled={templateBusy}
                      maxLength={TALON_DESCRIPTION_MAX_LENGTH}
                      placeholder="what this template is for"
                      className="h-9 min-w-0 bg-background border-border"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    data-testid="talon-template-submit"
                    onClick={() => void submitTemplateForm()}
                    disabled={templateBusy}
                    className="cursor-pointer"
                  >
                    {templateBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {templateForm.mode === 'rename' ? 'rename' : 'save template'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={closeTemplateForm}
                    disabled={templateBusy}
                    className="cursor-pointer"
                  >
                    cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Inline replace-confirm — a template with this name already
                exists. Name uniqueness is not enforced server-side in any
                preset family, so this is where it is caught. */}
            {pendingReplace && templateForm && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5">
                <span className="text-muted-foreground">
                  template &ldquo;{pendingReplace.name}&rdquo; already exists. replace it?
                </span>
                <button
                  type="button"
                  data-testid="talon-template-replace"
                  onClick={() =>
                    void writeTemplate(
                      templateForm.name.trim(),
                      templateForm.description.trim(),
                      pendingReplace,
                    )
                  }
                  disabled={templateBusy}
                  className="flex items-center gap-1 rounded bg-accent-cyan/10 px-2 py-0.5 font-medium text-accent-cyan transition-colors hover:bg-accent-cyan/15 hover:text-accent-cyan-hover dark:bg-accent-cyan/20 dark:hover:bg-accent-cyan/40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <Save className="h-3 w-3" /> yes, replace
                </button>
                <button
                  type="button"
                  onClick={() => setPendingReplace(null)}
                  disabled={templateBusy}
                  className="rounded px-2 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer disabled:cursor-not-allowed"
                >
                  cancel
                </button>
              </div>
            )}

            {selectedTemplate?.description && !templateForm && (
              <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
            )}
          </div>
        )}

        {/* name | description | cooldown on ONE row at md+. The cooldown column
            is sized to its content (a 3-digit box plus "minutes") so the two
            text fields keep the width that actually needs it. */}
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
          <div className="space-y-2">
            <Label htmlFor="talon-name">name</Label>
            <Input
              id="talon-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={busy}
              maxLength={TALON_NAME_MAX_LENGTH}
              required
              placeholder="restart the lobby loop overnight"
              aria-invalid={!!errorFor('name')}
              className="bg-background border-border"
            />
            {errorFor('name') && (
              <p role="alert" className="text-xs text-destructive">
                {errorFor('name')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="talon-description">
              description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="talon-description"
              value={description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              disabled={busy}
              maxLength={TALON_DESCRIPTION_MAX_LENGTH}
              placeholder="what this talon is for"
              aria-invalid={!!errorFor('description')}
              className="bg-background border-border"
            />
            {errorFor('description') && (
              <p role="alert" className="text-xs text-destructive">
                {errorFor('description')}
              </p>
            )}
          </div>
          {/* Cooldown had no control until templates arrived, and an omitted one
              silently resets to the 60-minute default — which every event and
              threshold template sets deliberately. Third column of the row
              above: the hint moves into the label's title rather than sitting
              under a narrow column, where it wrapped to three lines and made
              this row taller than the two text fields it shares. */}
          <div className="space-y-2">
            <Label htmlFor="talon-cooldown" title="0 lets it run every time the trigger fires">
              run at most once every
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="talon-cooldown"
                type="number"
                inputMode="numeric"
                min={0}
                max={TALON_MAX_COOLDOWN_MINUTES}
                value={cooldownValue}
                onChange={(e) => handleCooldownChange(e.target.value)}
                disabled={busy}
                aria-invalid={!!errorFor('cooldownMinutes')}
                aria-describedby="talon-cooldown-hint"
                className="w-20 bg-background border-border"
              />
              <span id="talon-cooldown-hint" className="text-sm text-muted-foreground whitespace-nowrap">
                minutes
              </span>
            </div>
            {errorFor('cooldownMinutes') && (
              <p role="alert" className="text-xs text-destructive">
                {errorFor('cooldownMinutes')}
              </p>
            )}
          </div>
        </div>

        {/* Each card sits in a `grid` wrapper rather than being the grid item
            itself: the wrapper is what `PipelineConnectors` measures, and a
            single-item grid still stretches the card to the row height the way
            the bare section did. */}
        <div className="relative">
          {/* Wide horizontal gutters at md+ — the connector fan lives in them,
              and at gap-5 the wires sat on top of the card borders. */}
          <div className="grid md:grid-cols-3 gap-5 md:gap-x-10">
            <div data-talon-node="trigger-card" className="grid">
              <TriggerCard
                draft={trigger}
                onChange={handleTriggerChange}
                minIntervalMinutes={minIntervalMinutes}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
            <PipelineStackConnector />
            <div data-talon-node="condition-card" className="grid">
              <ConditionCard
                draft={condition}
                onChange={handleConditionChange}
                scope={scope}
                onScopeChange={handleScopeChange}
                machines={machines}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
            <PipelineStackConnector />
            <div data-talon-node="outputs-card" className="grid">
              <OutputsCard
                drafts={outputs}
                onChange={handleOutputsChange}
                machines={scopedMachines}
                isSiteAdmin={isSiteAdmin}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
          </div>
          <PipelineConnectors outputCount={outputs.length} />
        </div>
      </div>

      {/* Only what no control renders inline — see `slotForField`. */}
      {summaryMessages.length > 0 && (
        <div className="space-y-2">
          {summaryMessages.map((message) => (
            <FormError key={message} message={message} />
          ))}
        </div>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="submit"
          data-testid="talon-editor-save"
          disabled={busy}
          className="cursor-pointer"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : talon ? (
            'save talon'
          ) : (
            'create talon'
          )}
        </Button>
      </DialogFooter>

      <ConfirmDialog
        open={confirmDeleteTemplate}
        onOpenChange={setConfirmDeleteTemplate}
        title="delete template?"
        description={
          selectedTemplate
            ? `"${selectedTemplate.name}" will no longer be offered when creating a talon. talons already made from it are unaffected.`
            : ''
        }
        confirmText="delete"
        cancelText="cancel"
        variant="destructive"
        onConfirm={() => void handleDeleteTemplate()}
      />
    </form>
  );
}
