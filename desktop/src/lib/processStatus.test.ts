import { describe, expect, it } from 'vitest'
import {
  isLive,
  launchedAtForProcess,
  candidatePidsForProcess,
  livePidForProcess,
  markKilled,
  markRestarting,
  parseAppStates,
  recordedIdentity,
  restoreState,
  statusForProcess,
  statusLabel,
  STATUS_DOT,
  STATUS_TEXT,
  PROCESS_STATUSES,
  type AppStates,
} from './processStatus'

describe('parsing the service’s table', () => {
  it('keeps well-formed entries whole, including fields we do not read', () => {
    const states = parseAppStates({
      '18244': { id: 'a', status: 'RUNNING', timestamp: 1_786_562_574, restarts: 2 },
    })

    expect(states['18244']).toEqual({
      id: 'a',
      status: 'RUNNING',
      timestamp: 1_786_562_574,
      restarts: 2,
    })
  })

  it('drops anything that is not a pid mapping to an object', () => {
    const states = parseAppStates({
      '18244': { id: 'a', status: 'RUNNING' },
      None: { id: 'b', status: 'RUNNING' },
      '99': 'RUNNING',
      '100': null,
    })

    expect(Object.keys(states)).toEqual(['18244'])
  })

  it('treats a missing or nonsense document as an empty table', () => {
    expect(parseAppStates({})).toEqual({})
    expect(parseAppStates(null)).toEqual({})
    expect(parseAppStates([1, 2])).toEqual({})
    expect(parseAppStates('RUNNING')).toEqual({})
  })
})

describe('status for a config entry', () => {
  const states: AppStates = {
    '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
    '200': { id: 'a', status: 'LAUNCH_FAILED', timestamp: 20 },
    '300': { id: 'b', status: 'RUNNING', timestamp: 5 },
  }

  it('reports the newest generation, not the happiest one', () => {
    expect(statusForProcess(states, 'a')).toBe('LAUNCH_FAILED')
    expect(statusForProcess(states, 'b')).toBe('RUNNING')
  })

  it('shows the operator’s kill even though an older pid still says running', () => {
    const killed = markKilled(states, 200, 'a')

    expect(statusForProcess(killed, 'a')).toBe('KILLED')
  })

  it('does not let a stale kill shadow a live adopted generation (2026-09-04 incident)', () => {
    // Reproduced live: the service adopted pid 5516 (adopted rows carry no
    // timestamp) while the KILLED row for pid 1528 kept its launch timestamp.
    // Missing-as-oldest sorted the dead row first, the pane said "killed", and
    // the run controls - keyed off the displayed status - went dead while the
    // process ran.
    const incident: AppStates = {
      '1528': { id: 'a', status: 'KILLED', timestamp: 1_786_562_574 },
      '5516': { id: 'a', status: 'RUNNING' },
    }

    expect(statusForProcess(incident, 'a')).toBe('RUNNING')
    expect(isLive(statusForProcess(incident, 'a'))).toBe(true)
  })

  it('does not let a dead timestamp-less row shadow a live launched one', () => {
    // The inverse guard: a missing timestamp reads as "now" only when the
    // status says the process is alive. A dead adopted row carries no evidence
    // of recency and must not outrank a live launched generation.
    const mirrored: AppStates = {
      '1528': { id: 'a', status: 'KILLED' },
      '5516': { id: 'a', status: 'RUNNING', timestamp: 1_786_562_574 },
    }

    expect(statusForProcess(mirrored, 'a')).toBe('RUNNING')
  })

  it('still shows the kill of an adopted row when it is the only generation', () => {
    // markKilled preserves the row, so an adopted generation stays
    // timestamp-less after the operator stops it - the kill must show anyway.
    const killed = markKilled({ '5516': { id: 'a', status: 'RUNNING' } }, 5516, 'a')

    expect(statusForProcess(killed, 'a')).toBe('KILLED')
  })

  it('is inactive for an entry the service has never launched', () => {
    expect(statusForProcess(states, 'never-launched')).toBe('INACTIVE')
  })

  it('is inactive for a status word it does not recognise', () => {
    expect(statusForProcess({ '1': { id: 'a', status: 'PONDERING', timestamp: 1 } }, 'a')).toBe(
      'INACTIVE',
    )
  })

  it('has a dot and a lowercase label for every status', () => {
    expect(statusLabel('RUNNING')).toBe('running')
    // The dashboard calls this one "failed"; so do we.
    expect(statusLabel('LAUNCH_FAILED')).toBe('failed')
    expect(statusLabel('RESTARTING')).toBe('restarting')
    for (const status of PROCESS_STATUSES) {
      expect(STATUS_DOT[status]).toBeTruthy()
      expect(STATUS_TEXT[status]).toBeTruthy()
    }
  })

  it('recognises the marker this app writes for a restart', () => {
    // Not knowing our own write would blank the row to inactive for the couple
    // of seconds the service takes to relaunch.
    expect(statusForProcess({ '1': { id: 'a', status: 'RESTARTING', timestamp: 1 } }, 'a')).toBe(
      'RESTARTING',
    )
  })
})

describe('picking a pid to act on', () => {
  it('prefers a running generation over a newer dead one', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '200': { id: 'a', status: 'LAUNCH_FAILED', timestamp: 20 },
    }

    expect(livePidForProcess(states, 'a')).toBe(100)
  })

  it('takes the newest running generation when there are several', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '400': { id: 'a', status: 'RUNNING', timestamp: 40 },
    }

    expect(livePidForProcess(states, 'a')).toBe(400)
  })

  it('falls back to the newest generation of any status', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'KILLED', timestamp: 10 },
      '200': { id: 'a', status: 'STOPPED', timestamp: 20 },
    }

    expect(livePidForProcess(states, 'a')).toBe(200)
  })

  it('breaks a timestamp tie on the higher pid', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'STOPPED' },
      '200': { id: 'a', status: 'STOPPED' },
    }

    expect(livePidForProcess(states, 'a')).toBe(200)
  })

  it('has nothing to offer when the entry owns no pids', () => {
    expect(livePidForProcess({}, 'a')).toBeNull()
  })

  it('lists every generation, live ones first, so a stale RUNNING row is not the end', () => {
    // Adopted rows carry no timestamp, and a dead generation can sit at RUNNING
    // until the service sweeps it — the higher pid is not necessarily the live one.
    const states: AppStates = {
      '30968': { id: 'a', status: 'RUNNING' },
      '14128': { id: 'a', status: 'RUNNING' },
      '25308': { id: 'a', status: 'KILLED' },
      '999': { id: 'b', status: 'RUNNING' },
    }

    expect(candidatePidsForProcess(states, 'a')).toEqual([30968, 14128, 25308])
  })

  it('tries a live adopted generation before an older timestamped live row', () => {
    // The adopted row is what the service manages right now; the timestamped
    // RUNNING row is an older generation that may be a corpse awaiting sweep.
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '5516': { id: 'a', status: 'RUNNING' },
    }

    expect(candidatePidsForProcess(states, 'a')).toEqual([5516, 100])
  })
})

describe('what the service recorded about a pid', () => {
  it('carries the creation time and image the service read at launch or adoption', () => {
    const exe = 'c:\\apps\\player.exe'
    expect(recordedIdentity({ id: 'a', status: 'RUNNING', create_time: 1788367385.5616167, exe })).toEqual({
      createTime: 1788367385.5616167,
      exe,
    })
  })

  it('checks the creation time alone when no image was recorded', () => {
    expect(recordedIdentity({ id: 'a', create_time: 1788367385.5, exe: 42 })).toEqual({
      createTime: 1788367385.5,
      exe: null,
    })
  })

  it('has nothing for a row with no usable creation time', () => {
    // older agents, and a LAUNCH_FAILED row the service strips, write none
    expect(recordedIdentity({ id: 'a', status: 'RUNNING', exe: 'c:\\apps\\player.exe' })).toBeNull()
    expect(recordedIdentity({ id: 'a', create_time: null })).toBeNull()
    expect(recordedIdentity({ id: 'a', create_time: '1788367385.5' })).toBeNull()
    expect(recordedIdentity(undefined)).toBeNull()
  })
})

describe('whether there is a process to act on', () => {
  it('accepts the four statuses that describe a live generation', () => {
    expect(PROCESS_STATUSES.filter(isLive)).toEqual([
      'RUNNING',
      'LAUNCHING',
      'RESTARTING',
      'STALLED',
    ])
  })

  it('treats a stalled process as live, because it is', () => {
    // The service writes STALLED while a process is hung but before it decides
    // to kill anything (owlette_service.py:2828-2829). It was missing from
    // PROCESS_STATUSES, so statusForProcess fell through to its INACTIVE
    // default and isLive said false — the app showed "inactive" for a hung
    // process and disabled the restart button that answers it.
    const states: AppStates = { '900': { id: 'a', status: 'STALLED', timestamp: 5 } }
    expect(statusForProcess(states, 'a')).toBe('STALLED')
    expect(isLive('STALLED')).toBe(true)
    expect(statusLabel('STALLED')).toBe('stalled')
  })

  it('refuses the ones that describe a generation that ended or never began', () => {
    for (const status of ['QUEUED', 'LAUNCH_FAILED', 'KILLED', 'STOPPED', 'INACTIVE'] as const) {
      expect(isLive(status)).toBe(false)
    }
  })
})

describe('when the live generation was launched', () => {
  it('reads the newest generation’s launch time, in milliseconds', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'STOPPED', timestamp: 1_786_562_000 },
      '400': { id: 'a', status: 'RUNNING', timestamp: 1_786_562_574 },
    }

    expect(launchedAtForProcess(states, 'a')).toBe(1_786_562_574_000)
  })

  it('has nothing for an entry the service has never launched', () => {
    expect(launchedAtForProcess({}, 'a')).toBeNull()
    // The service writes a status without a timestamp when it adopts a process
    // it did not start.
    expect(launchedAtForProcess({ '100': { id: 'a', status: 'RUNNING' } }, 'a')).toBeNull()
    expect(
      launchedAtForProcess({ '100': { id: 'a', status: 'RUNNING', timestamp: 0 } }, 'a'),
    ).toBeNull()
  })

  it('ignores a timestamp that is not a number', () => {
    const states = {
      '100': { id: 'a', status: 'RUNNING', timestamp: '1786562574' },
    } as unknown as AppStates

    expect(launchedAtForProcess(states, 'a')).toBeNull()
  })

  it('stays honest when a live adopted row outranks a timestamped dead one', () => {
    // Same newest row statusForProcess reports for the 2026-09-04 incident
    // shape: the adopted generation, whose launch time is unknown. Showing the
    // dead row's stamp beside the adopted process would claim a launch time
    // that is not its own.
    const incident: AppStates = {
      '1528': { id: 'a', status: 'KILLED', timestamp: 1_786_562_574 },
      '5516': { id: 'a', status: 'RUNNING' },
    }

    expect(launchedAtForProcess(incident, 'a')).toBeNull()
  })
})

describe('the operator’s markers', () => {
  const states: AppStates = {
    '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
    '300': { id: 'b', status: 'RUNNING', timestamp: 30 },
  }

  it('rewrites one pid and leaves the rest of the file alone', () => {
    const marked = markKilled(states, 100, 'a')

    expect(marked['100']).toEqual({ id: 'a', status: 'KILLED', timestamp: 10 })
    expect(marked['300']).toBe(states['300'])
    expect(states['100'].status).toBe('RUNNING')
  })

  it('says RESTARTING when the operator asked for the process back', () => {
    const marked = markRestarting(states, 100, 'a')

    expect(marked['100']).toEqual({ id: 'a', status: 'RESTARTING', timestamp: 10 })
    expect(marked['300']).toBe(states['300'])
  })

  it('creates the entry when the pid is not in the table yet', () => {
    expect(markKilled({}, 42, 'a')).toEqual({ '42': { status: 'KILLED', id: 'a' } })
  })

  it('restores a row whole, for a marker that turned out to be premature', () => {
    const marked = markRestarting(states, 100, 'a')

    expect(restoreState(marked, 100, states['100'])).toEqual(states)
  })
})
