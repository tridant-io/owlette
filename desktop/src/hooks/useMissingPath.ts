import { useCallback, useRef, useState } from 'react'
import { pathStatus } from '@/lib/ipc'
import { desktopOs } from '@/lib/launchCopy'
import { findMissingPath, type MissingPath, type PathField } from '@/lib/missingPath'

export type MissingPathWarning = MissingPath & {
  field: PathField
  /** what the warning is about: a process id, or a dropped file's path. */
  subject: string
}

/**
 * warnings about paths just entered, in the order the machine answered. only the
 * newest check of one subject's field may speak, and nothing else silences it: a
 * slow one outlives moving on to another field or another process.
 */
export function useMissingPath() {
  const [warnings, setWarnings] = useState<MissingPathWarning[]>([])
  const newest = useRef(new Map<string, number>())

  const check = useCallback((subject: string, entries: [PathField, string][]) => {
    for (const [field, value] of entries) {
      const key = `${field} ${subject}`
      const mine = (newest.current.get(key) ?? 0) + 1
      newest.current.set(key, mine)
      setWarnings((current) => current.filter((warning) => warning.subject !== subject || warning.field !== field))
      void findMissingPath(field, value, pathStatus, desktopOs()).then((found) => {
        if (found && mine === newest.current.get(key)) {
          setWarnings((current) => [...current, { ...found, field, subject }])
        }
      })
    }
  }, [])

  const dismiss = useCallback((warning: MissingPathWarning) => {
    setWarnings((current) => current.filter((other) => other !== warning))
  }, [])

  return { warnings, check, dismiss }
}
