'use client';

/**
 * Stage 3 of the talon pipeline — WHAT happens when it fires.
 *
 * One to five rows (`TALON_MIN_OUTPUTS`…`TALON_MAX_OUTPUTS`), each with its own
 * config. Rows carry a client-side `key` so React identity survives
 * reorder-by-removal; it is never persisted — `TalonOutput` has no id.
 *
 * `command` outputs queue real process control, so the store only accepts them
 * from a site admin (`assertCommandOutputsAllowed`) and the picker offers
 * `command` only when `isSiteAdmin`. An EXISTING command row still renders for
 * a non-admin so an edit can't silently drop it; the server then refuses the
 * save, which is the honest outcome.
 *
 * Naming: the assistant is **hoot** in copy; the wire type stays `'cortex'`.
 */

import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  TALON_COMMAND_TYPES,
  type TalonCommandType,
  type TalonOutput,
  type TalonOutputType,
} from '@/lib/talons/types';
import { TALON_DIRECTIVE_MAX_LENGTH, TALON_MAX_OUTPUTS } from '@/lib/talons/validation';

import type { TalonMachineOption } from './ConditionCard';

// draft shape

export interface OutputDraft {
  /** React key only — outputs have no persisted id. */
  key: string;
  type: TalonOutputType;
  url: string;
  directive: string;
  /**
   * hoot outputs only — may hoot use its repair tools, or only investigate?
   * Off by default: acting unasked is the thing an operator must opt into.
   */
  allowActions: boolean;
  commandType: TalonCommandType;
  processId: string;
  processName: string;
  /** The user chose to type a process name rather than pick one off a machine. */
  customProcess: boolean;
}

const OUTPUT_TYPE_LABELS: Record<TalonOutputType, string> = {
  email: 'email',
  webhook: 'webhook',
  cortex: 'hoot',
  command: 'command',
};

const COMMAND_TYPE_LABELS: Record<TalonCommandType, string> = {
  restart_process: 'restart process',
  start_process: 'start process',
  stop_process: 'stop process',
};

/** Sentinel select value for "type the process name myself". */
const CUSTOM_PROCESS_VALUE = '__custom__';

function newOutputKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newOutputDraft(type: TalonOutputType = 'email'): OutputDraft {
  return {
    key: newOutputKey(),
    type,
    url: '',
    directive: '',
    allowActions: false,
    commandType: 'restart_process',
    processId: '',
    processName: '',
    customProcess: false,
  };
}

export function outputDraftFromTalon(output: TalonOutput): OutputDraft {
  const draft = newOutputDraft(output.type);
  if (output.type === 'webhook') draft.url = output.url;
  if (output.type === 'cortex') {
    draft.directive = output.directive;
    // Absent means "investigate only" — the same talon as an explicit false.
    draft.allowActions = output.allowActions === true;
  }
  if (output.type === 'command') {
    draft.commandType = output.commandType;
    draft.processId = output.processId ?? '';
    draft.processName = output.processName ?? '';
    // A stored name with no id can only have come from the free-text path.
    draft.customProcess = !output.processId && !!output.processName;
  }
  return draft;
}

export function outputDraftToInput(draft: OutputDraft): TalonOutput {
  switch (draft.type) {
    case 'email':
      return { type: 'email' };
    case 'webhook':
      return { type: 'webhook', url: draft.url };
    case 'cortex':
      // Sent only when on, so "investigate only" persists as the absence of the
      // permission rather than a stored `false` — same shape a template stores.
      return {
        type: 'cortex',
        directive: draft.directive,
        ...(draft.allowActions ? { allowActions: true } : {}),
      };
    case 'command':
      return {
        type: 'command',
        commandType: draft.commandType,
        ...(draft.processId ? { processId: draft.processId } : {}),
        ...(draft.processName.trim() ? { processName: draft.processName } : {}),
      };
  }
}

// process options

interface ProcessOption {
  /** `id:<processId>` or `name:<processName>` — ids win when the agent reported one. */
  value: string;
  label: string;
  processId: string;
  processName: string;
}

/** Distinct processes across the machines in scope, ids preferred over names. */
function processOptions(machines: TalonMachineOption[]): ProcessOption[] {
  const options = new Map<string, ProcessOption>();
  for (const machine of machines) {
    for (const process of machine.processes ?? []) {
      const value = process.id ? `id:${process.id}` : `name:${process.name}`;
      if (options.has(value)) continue;
      options.set(value, {
        value,
        label: process.name,
        processId: process.id ?? '',
        processName: process.id ? '' : process.name,
      });
    }
  }
  return [...options.values()];
}

/** `''` keeps the select controlled while still showing its placeholder. */
function selectedProcessValue(draft: OutputDraft): string {
  if (draft.customProcess) return CUSTOM_PROCESS_VALUE;
  if (draft.processId) return `id:${draft.processId}`;
  if (draft.processName) return `name:${draft.processName}`;
  return '';
}

// card

interface OutputsCardProps {
  drafts: OutputDraft[];
  onChange: (drafts: OutputDraft[]) => void;
  /** Machines in scope — the source of the process picker's options. */
  machines: TalonMachineOption[];
  isSiteAdmin: boolean;
  disabled: boolean;
  /**
   * Message for one error slot — see `slotForField` in `TalonEditorDialog`.
   * `outputs` is the LIST's own slot (too few, too many, malformed row); per-row
   * paths have their own slots and are never folded in, which is what stopped a
   * row's message printing twice.
   */
  errorFor: (slot: string) => string | undefined;
}

export function OutputsCard({
  drafts,
  onChange,
  machines,
  isSiteAdmin,
  disabled,
  errorFor,
}: OutputsCardProps) {
  const options = processOptions(machines);
  const outputsError = errorFor('outputs');
  const atLimit = drafts.length >= TALON_MAX_OUTPUTS;

  const patch = (index: number, changes: Partial<OutputDraft>) =>
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));

  const availableTypes = (Object.keys(OUTPUT_TYPE_LABELS) as TalonOutputType[]).filter(
    (type) => type !== 'command' || isSiteAdmin,
  );

  return (
    <section className="rounded-lg border border-border bg-background/40 p-5 space-y-4">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">outputs</Label>

      <div className="space-y-3">
        {drafts.map((draft, index) => {
          const typeOptions =
            draft.type === 'command' && !isSiteAdmin ? [...availableTypes, 'command' as const] : availableTypes;
          const showCustomProcess = draft.customProcess || options.length === 0;
          const urlError = errorFor(`outputs[${index}].url`);
          const directiveError = errorFor(`outputs[${index}].directive`);
          // One slot for the command target: the row shows either the picker
          // or the free-text name, never both errors at once.
          const commandError = errorFor(`outputs[${index}].command`);

          return (
            // `data-talon-node` is the measurement hook PipelineConnectors uses
            // to land one fan arm on each row; `data-testid` stays as-is.
            <div
              key={draft.key}
              data-testid="output-row"
              data-talon-node="output-row"
              className="rounded-md border border-border p-3 space-y-2"
            >
              <div className="flex items-center gap-2">
                <Select
                  value={draft.type}
                  onValueChange={(value) => patch(index, { type: value as TalonOutputType })}
                  disabled={disabled}
                >
                  <SelectTrigger
                    id={`talon-output-${index}-type`}
                    aria-label={`output ${index + 1} type`}
                    className="flex-1 bg-background border-border"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((type) => (
                      <SelectItem key={type} value={type}>
                        {OUTPUT_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {drafts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onChange(drafts.filter((_, i) => i !== index))}
                    disabled={disabled}
                    aria-label={`remove output ${index + 1}`}
                    className="h-6 w-6 rounded-md text-muted-foreground hover:text-danger hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>

              {draft.type === 'email' && (
                <p className="text-xs text-muted-foreground">
                  emails site members who have talon alerts enabled.
                </p>
              )}

              {draft.type === 'webhook' && (
                <div className="space-y-1">
                  <Input
                    id={`talon-output-${index}-url`}
                    type="url"
                    value={draft.url}
                    onChange={(e) => patch(index, { url: e.target.value })}
                    disabled={disabled}
                    aria-invalid={!!urlError}
                    aria-label={`output ${index + 1} url`}
                    placeholder="https://example.com/hooks/talon"
                    className="bg-background border-border"
                  />
                  {urlError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {urlError}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      must be https. every delivery is signed with hmac-sha256.
                    </p>
                  )}
                </div>
              )}

              {draft.type === 'cortex' && (
                <div className="space-y-1">
                  <Textarea
                    id={`talon-output-${index}-directive`}
                    value={draft.directive}
                    onChange={(e) => patch(index, { directive: e.target.value })}
                    disabled={disabled}
                    maxLength={TALON_DIRECTIVE_MAX_LENGTH}
                    rows={3}
                    aria-invalid={!!directiveError}
                    aria-label={`output ${index + 1} directive`}
                    placeholder="restart the loop if it's safe to — otherwise investigate and escalate"
                    className="bg-background border-border text-sm"
                  />
                  {directiveError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {directiveError}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      when this talon fires, hoot — owlette&apos;s ai assistant — follows this
                      instruction in a new chat you can watch.
                    </p>
                  )}

                  {/* The one permission this output carries, so it says plainly
                      what it does and does not extend to. */}
                  <div className="space-y-1 rounded-md border border-border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label
                        htmlFor={`talon-output-${index}-allow-actions`}
                        className="text-xs text-foreground"
                      >
                        let hoot act
                      </Label>
                      <Switch
                        id={`talon-output-${index}-allow-actions`}
                        checked={draft.allowActions}
                        onCheckedChange={(checked) => patch(index, { allowActions: checked === true })}
                        disabled={disabled}
                        aria-label={`output ${index + 1} let hoot act`}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      off, hoot investigates and writes up what it found. on, it can also restart
                      processes, restart services and free disk space on that machine. either way it
                      can never run scripts, write files, deploy, or reboot.
                    </p>
                  </div>
                </div>
              )}

              {draft.type === 'command' && (
                <div className="space-y-2">
                  <Select
                    value={draft.commandType}
                    onValueChange={(value) => patch(index, { commandType: value as TalonCommandType })}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      id={`talon-output-${index}-command-type`}
                      aria-label={`output ${index + 1} command`}
                      aria-invalid={!!commandError}
                      className="w-full bg-background border-border"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TALON_COMMAND_TYPES.map((commandType) => (
                        <SelectItem key={commandType} value={commandType}>
                          {COMMAND_TYPE_LABELS[commandType]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {options.length > 0 && (
                    <Select
                      value={selectedProcessValue(draft)}
                      onValueChange={(value) =>
                        value === CUSTOM_PROCESS_VALUE
                          ? patch(index, { customProcess: true, processId: '', processName: '' })
                          : patch(index, {
                              customProcess: false,
                              processId: options.find((o) => o.value === value)?.processId ?? '',
                              processName: options.find((o) => o.value === value)?.processName ?? '',
                            })
                      }
                      disabled={disabled}
                    >
                      <SelectTrigger
                        aria-label={`output ${index + 1} process`}
                        className="w-full bg-background border-border"
                      >
                        <SelectValue placeholder="choose a process" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                        <SelectItem value={CUSTOM_PROCESS_VALUE}>type a name</SelectItem>
                      </SelectContent>
                    </Select>
                  )}

                  {showCustomProcess && (
                    <Input
                      id={`talon-output-${index}-process`}
                      value={draft.processName}
                      onChange={(e) => patch(index, { processName: e.target.value, customProcess: true })}
                      disabled={disabled}
                      aria-invalid={!!commandError}
                      aria-label={`output ${index + 1} process name`}
                      placeholder="process name"
                      className="bg-background border-border"
                    />
                  )}

                  {commandError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {commandError}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      runs on every machine in scope, one at a time.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="output-add"
        onClick={() => onChange([...drafts, newOutputDraft()])}
        disabled={disabled || atLimit}
        className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Plus className="h-3 w-3 mr-1" />
        add output
      </Button>

      {outputsError ? (
        <p role="alert" className="text-xs text-destructive" id="talon-outputs">
          {outputsError}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" id="talon-outputs">
          up to {TALON_MAX_OUTPUTS} outputs per talon.
        </p>
      )}
    </section>
  );
}
