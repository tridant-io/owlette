'use client';

/**
 * asks a machine about the path fields a save just changed, in the background.
 * only a clear answer that something is wrong speaks: an offline machine, a
 * timeout, a refusal or an agent older than `check_path` all end in null, and null
 * says nothing. a warning outlives the user moving on to another process, so it
 * carries the process it is about, and it goes when that process is gone or the
 * field holds something else. leaving the site drops everything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { watchCommandOutcome } from '@/hooks/useCommandResult';
import {
  parsePathAnswer,
  type PathAnswer,
  type PathCheckField,
  type PathField,
  type PathWarningKind,
} from '@/lib/pathCheck';

/** the agent polls commands every few seconds and answers inside three. */
export const PATH_ANSWER_TIMEOUT_MS = 15_000;

export interface PathChange {
  field: PathField;
  value: string;
}

export interface PathWarning {
  machineId: string;
  /** the process this warning is about, whatever else is on screen by now. */
  processId: string;
  processName: string;
  field: PathField;
  /** what the field held when it was asked about. */
  value: string;
  kind: PathWarningKind;
  path: string;
  rest: string;
  nearest: string | null;
}

function fieldKey(machineId: string, processId: string, field: PathField): string {
  return `${machineId} ${processId} ${field}`;
}

function warningKey(warning: PathWarning): string {
  return `${fieldKey(warning.machineId, warning.processId, warning.field)} ${warning.value}`;
}

function stillHolds(warning: PathWarning, processes: unknown[]): boolean {
  const row = processes.find(
    (process) => (process as { id?: unknown } | null)?.id === warning.processId,
  ) as Record<string, unknown> | undefined;
  const value = row?.[warning.field];
  return typeof value === 'string' && value.trim() === warning.value;
}

export function usePathCheck(siteId: string) {
  const [warnings, setWarnings] = useState<PathWarning[]>([]);
  // the warning the saved config has been read for: until then it may be stale.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const open = useRef(new Set<() => void>());
  // only the newest check of one field may speak.
  const newest = useRef(new Map<string, number>());

  const ask = useCallback(
    (machineId: string, field: PathCheckField, value: string) =>
      new Promise<PathAnswer | null>((resolve) => {
        let settled = false;
        let stopWatching = () => {};
        const finish = (answer: PathAnswer | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stopWatching();
          open.current.delete(abort);
          resolve(answer);
        };
        const abort = () => finish(null);
        const timer = setTimeout(abort, PATH_ANSWER_TIMEOUT_MS);
        open.current.add(abort);

        fetch(
          `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/path-check`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field, value }),
          },
        )
          .then(async (res) => {
            if (!res.ok) return abort();
            const body = (await res.json()) as { data: { commandId: string } };
            if (settled) return;
            stopWatching = watchCommandOutcome(siteId, machineId, body.data.commandId, (outcome) => {
              finish(outcome.status === 'completed' ? parsePathAnswer(outcome.result) : null);
            });
          })
          .catch(abort);
      }),
    [siteId],
  );

  const check = useCallback(
    (machineId: string, processId: string, processName: string, changes: PathChange[]) => {
      for (const { field, value } of changes) {
        const key = fieldKey(machineId, processId, field);
        const mine = (newest.current.get(key) ?? 0) + 1;
        newest.current.set(key, mine);
        setWarnings((current) =>
          current.filter((warning) => fieldKey(warning.machineId, warning.processId, warning.field) !== key),
        );
        void ask(machineId, field, value).then((answer) => {
          if (newest.current.get(key) !== mine || !answer?.warning || answer.path === null) return;
          const warning: PathWarning = {
            machineId,
            processId,
            processName,
            field,
            value,
            kind: answer.warning,
            path: answer.path,
            rest: answer.rest,
            nearest: answer.nearest,
          };
          setWarnings((current) => [...current, warning]);
        });
      }
    },
    [ask],
  );

  /** by what it warns about, so dismissing one twice can't take the next one with it. */
  const dismiss = useCallback((warning: PathWarning) => {
    const key = warningKey(warning);
    setWarnings((current) => current.filter((other) => warningKey(other) !== key));
  }, []);

  const listFolder = useCallback(
    (machineId: string, path: string) => ask(machineId, 'folder', path),
    [ask],
  );

  useEffect(
    () => () => {
      newest.current.clear();
      [...open.current].forEach((abort) => abort());
      setWarnings([]);
    },
    [siteId],
  );

  const head = warnings[0] ?? null;
  const headKey = head && warningKey(head);
  const headMachine = head?.machineId ?? null;

  // the machine's saved config says whether the warning still means anything.
  useEffect(() => {
    if (!db || !siteId || !headKey || !headMachine) return;
    return onSnapshot(
      doc(db, 'config', siteId, 'machines', headMachine),
      (snap) => {
        const stored = snap.exists() ? (snap.data() as { processes?: unknown }).processes : null;
        const processes = Array.isArray(stored) ? stored : [];
        setWarnings((current) =>
          current.filter((warning) => warning.machineId !== headMachine || stillHolds(warning, processes)),
        );
        setConfirmedKey(headKey);
      },
      (err) => {
        console.error('Error reading the process config for a path warning:', err);
      },
    );
  }, [siteId, headKey, headMachine]);

  return { warning: headKey !== null && confirmedKey === headKey ? head : null, check, dismiss, listFolder };
}
