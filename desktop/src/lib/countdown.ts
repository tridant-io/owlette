/**
 * The reboot countdown, as a value. Rules ported unchanged from the python
 * prompt 3.0.0 removed (`prompt_restart.py`): two-minute wait, an indefinite
 * operator pause, reboot the moment it runs out. The prompt is now a window in
 * this app, not a python process — hence
 * `owlette_service._is_restart_prompt_active` tracking its own launch instead
 * of scanning.
 *
 * State lives here, not in the component, so the arithmetic is testable without
 * a clock.
 */

/** Seconds on the clock when the prompt opens. */
export const RESTART_COUNTDOWN_SECONDS = 120

export interface CountdownState {
  /** Seconds left. Never below zero. */
  remaining: number
  /** True while the operator is holding the clock. */
  paused: boolean
}

export function startCountdown(seconds: number = RESTART_COUNTDOWN_SECONDS): CountdownState {
  return { remaining: Math.max(0, Math.floor(seconds)), paused: false }
}

/** One second passing. A paused or expired clock does not move. */
export function tick(state: CountdownState): CountdownState {
  if (state.paused || state.remaining <= 0) return state
  return { ...state, remaining: state.remaining - 1 }
}

export function togglePause(state: CountdownState): CountdownState {
  return { ...state, paused: !state.paused }
}

/** True once the machine should be restarted. */
export function hasExpired(state: CountdownState): boolean {
  return state.remaining <= 0
}

/** `m:ss`, the format the legacy dialog used. */
export function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(clamped / 60)
  const rest = clamped % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
