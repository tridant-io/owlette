/**
 * The queue between "files landed on the window" and "entries in config.json".
 *
 * A drop is never written straight through: the classifier's output is a proposal
 * (guessed name, chosen interpreter, sometimes no host application at all), so
 * each path becomes a card the operator confirms individually. Nine files means
 * nine cards and nine separate writes, so a mistake on card seven leaves the
 * first six intact.
 *
 * Pure and total. The component owns the array; this module only computes the
 * next one.
 */

import type {
  DropKind,
  DropResult,
  NeedsInput,
  ProcessEntryDraft,
  UnsupportedDrop,
} from '@/lib/dropClassifier'
import { launchCopy } from '@/lib/launchCopy'

/**
 * One proposed process awaiting confirmation. `path` is the identity — nothing
 * else about a drop is reliably unique — so re-dropping a file whose card is
 * still on screen updates that card rather than adding a second. (Two entries for
 * one path is legitimate, just not something a double drop should produce.)
 */
export interface DropCard {
  kind: DropKind
  path: string
  entry: ProcessEntryDraft
  /** Fields the classifier could not derive; the card must ask for them. */
  needsInput: NeedsInput[]
  /** Lowercase notes to show with the card. Usually empty. */
  warnings: string[]
}

export interface DropTriage {
  cards: DropCard[]
  /** Paths there is nothing to propose for; the caller reports these and moves on. */
  rejected: UnsupportedDrop[]
}

/** What each kind is called on screen — lowercase, like the rest of the ui. */
export const DROP_KIND_LABELS: Record<DropKind, string> = {
  touchdesigner: 'touchdesigner project',
  unity: 'unity build',
  executable: 'application',
  script: 'script',
}

/** Data, not a rule: "an application" but "a unity build" — no first-letter test
 *  gets both right. */
const KIND_ARTICLES: Record<DropKind, string> = {
  touchdesigner: 'a',
  unity: 'a',
  executable: 'an',
  script: 'a',
}

/** `a script`, `an application` — for a sentence about what a drop turned out to be. */
export function describeKind(kind: DropKind): string {
  return `${KIND_ARTICLES[kind]} ${DROP_KIND_LABELS[kind]}`
}

/** Split one classification pass into cards to show and paths to report. */
export function triage(results: readonly DropResult[]): DropTriage {
  const cards: DropCard[] = []
  const rejected: UnsupportedDrop[] = []

  for (const result of results) {
    if (result.kind === 'unsupported') rejected.push(result)
    else {
      cards.push({
        kind: result.kind,
        path: result.path,
        entry: result.entry,
        needsInput: result.needsInput,
        warnings: result.warnings,
      })
    }
  }

  return { cards, rejected }
}

/** Append cards for paths that are not already waiting. */
export function enqueueCards(
  queue: readonly DropCard[],
  incoming: readonly DropCard[],
): DropCard[] {
  const queued = new Set(queue.map((card) => pathKey(card.path)))
  const next = [...queue]

  for (const card of incoming) {
    const key = pathKey(card.path)
    if (queued.has(key)) continue
    queued.add(key)
    next.push(card)
  }

  return next
}

/** Drop one card, whether it was confirmed or skipped. */
export function dequeueCard(queue: readonly DropCard[], path: string): DropCard[] {
  const key = pathKey(path)
  return queue.filter((card) => pathKey(card.path) !== key)
}

/** Apply an operator's edit to the card for `path`. */
export function updateCard(
  queue: readonly DropCard[],
  path: string,
  patch: Partial<ProcessEntryDraft>,
): DropCard[] {
  const key = pathKey(path)
  return queue.map((card) =>
    pathKey(card.path) === key ? { ...card, entry: { ...card.entry, ...patch } } : card,
  )
}

/**
 * Why this card cannot be added yet, in the operator's words.
 *
 * The duplicate-name check is load-bearing: the web api 409s a second process
 * with an existing name, so one that slips past here lands on disk, uploads, and
 * is silently rejected in the cloud — a divergence nothing here would surface.
 */
export function cardBlockedReason(
  card: DropCard,
  existingNames: readonly string[],
): string | null {
  const name = card.entry.name.trim()
  if (!name) return 'a name is required'

  if (!card.entry.exe_path.trim()) {
    const copy = launchCopy()
    return card.kind === 'touchdesigner'
      ? `touchdesigner was not found on this machine — point this at ${copy.missingTouchDesigner}`
      : `no program was found to run this — point this at ${copy.missingTarget}`
  }

  const taken = existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())
  return taken ? `a process named ${name} already exists on this machine` : null
}

/** Case-insensitive, separator-agnostic — how Windows compares two paths. */
function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}
