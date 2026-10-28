'use client';

import { useEffect, useRef } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { toast } from '@/lib/toast';
import { db } from '@/lib/firebase';
import { launchCopy, type LaunchCopy } from '@/lib/launchCopy';

export interface ExeMissingToastAlert {
  id: string;
  machineId: string;
  processName: string;
  processId: string;
  exePath: string;
  suggestedPaths: string[];
}

type UseSuggestedPathHandler = (alert: ExeMissingToastAlert, suggestedPath: string) => void;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function buildExeMissingAlert(id: string, data: Record<string, unknown>): ExeMissingToastAlert {
  return {
    id,
    machineId: readString(data.machineId),
    processName: readString(data.processName) || 'unknown process',
    processId: readString(data.processId) || readString(data.process_id),
    exePath: readString(data.exePath) || readString(data.exe_path) || readString(data.details),
    suggestedPaths: [
      ...readStringArray(data.suggestedPaths),
      ...readStringArray(data.suggested_paths),
    ].slice(0, 5),
  };
}

/**
 * `launchCopyOf` names the missing target the way the alerting machine's
 * system does — an .exe, an .app or a program; without it, windows.
 */
export function useAgentAlertToasts(
  siteId: string,
  onUseSuggestedPath?: UseSuggestedPathHandler,
  launchCopyOf?: (machineId: string) => LaunchCopy,
): void {
  const onUseSuggestedPathRef = useRef(onUseSuggestedPath);
  const launchCopyOfRef = useRef(launchCopyOf);
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    onUseSuggestedPathRef.current = onUseSuggestedPath;
    launchCopyOfRef.current = launchCopyOf;
  }, [onUseSuggestedPath, launchCopyOf]);

  useEffect(() => {
    seenIdsRef.current = new Set();
    if (!db || !siteId) return;

    const q = query(
      collection(db, 'sites', siteId, 'logs'),
      where('action', '==', 'exe_missing'),
      limit(20),
    );
    let initialSnapshot = true;

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const added = snap.docChanges().filter((change) => change.type === 'added');

        if (initialSnapshot) {
          for (const change of added) {
            seenIdsRef.current.add(change.doc.id);
          }
          initialSnapshot = false;
          return;
        }

        for (const change of added) {
          const id = change.doc.id;
          if (seenIdsRef.current.has(id)) continue;
          seenIdsRef.current.add(id);

          const alert = buildExeMissingAlert(id, change.doc.data() as Record<string, unknown>);
          const suggestions = alert.suggestedPaths.slice(0, 2);
          const firstSuggestion = suggestions[0];
          const description = suggestions.length > 0
            ? `${alert.exePath}\nsuggested: ${suggestions.join(' | ')}`
            : alert.exePath;

          const { target } = launchCopyOfRef.current?.(alert.machineId) ?? launchCopy(undefined);
          toast.error(`${target} not found for ${alert.processName}`, {
            description,
            ...(firstSuggestion
              ? {
                  action: {
                    label: 'use path',
                    onClick: () => {
                      onUseSuggestedPathRef.current?.(alert, firstSuggestion);
                    },
                  },
                }
              : {}),
          });
        }
      },
      (error) => {
        console.debug('Agent alert toast listener error:', error);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [siteId]);
}
