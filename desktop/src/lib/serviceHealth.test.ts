import { describe, expect, it } from 'vitest'
import type { ServiceStatus } from './ipc'
import {
  deriveFooterState,
  footerSentence,
  isPaired,
  siteIdOf,
  siteNameOf,
  FOOTER_DOT_CLASS,
  FOOTER_TONE_CLASS,
  type FooterInputs,
  type FooterState,
  type FooterTone,
  type ServiceStatusFile,
} from './serviceHealth'

const healthy: ServiceStatus = {
  installed: true,
  running: true,
  state: 'running',
  startType: 'auto_start',
  stoppedCleanly: null,
  statusFile: { exists: true, ageSecs: 12, stale: false },
}

const connected: ServiceStatusFile = {
  service: { running: true, last_update: 1_786_562_574, version: '2.12.21' },
  firebase: { enabled: true, connected: true, site_id: 'default_site', last_heartbeat: 0 },
  health: { status: 'ok', error_code: null, error_message: null },
}

const joined = { firebase: { enabled: true, site_id: 'default_site' } }

describe('footer state', () => {
  it('says nothing until the first status query lands', () => {
    expect(deriveFooterState({ status: null, statusFile: null, config: null })).toMatchObject({
      label: 'checking',
      tone: 'muted',
    })
  })

  it('is connected when the service says so', () => {
    expect(
      deriveFooterState({ status: healthy, statusFile: connected, config: joined }),
    ).toMatchObject({ label: 'connected', tone: 'ok', serviceDown: false })
  })

  it('reports a stopped service ahead of anything the file claims', () => {
    const stopped: ServiceStatus = { ...healthy, running: false, state: 'stopped' }

    expect(
      deriveFooterState({ status: stopped, statusFile: connected, config: joined }),
    ).toMatchObject({ label: 'stopped', tone: 'muted', serviceDown: true, action: 'start' })
  })

  it('treats a two-minute-old status file as the service being gone', () => {
    const wedged: ServiceStatus = {
      ...healthy,
      statusFile: { exists: true, ageSecs: 300, stale: true },
    }
    const state = deriveFooterState({ status: wedged, statusFile: connected, config: joined })

    expect(state.label).toBe('not responding')
    expect(state.tone).toBe('error')
    expect(state.detail).toMatch(/status file/)
  })

  it('says so when the service is not installed at all', () => {
    const absent: ServiceStatus = { ...healthy, installed: false }

    expect(deriveFooterState({ status: absent, statusFile: null, config: joined }).detail).toMatch(
      /not installed/,
    )
  })

  it('is disabled when cloud features are off in the config', () => {
    expect(
      deriveFooterState({
        status: healthy,
        statusFile: connected,
        config: { firebase: { enabled: false, site_id: 'default_site' } },
      }),
    ).toMatchObject({ label: 'cloud disabled', tone: 'muted' })
  })

  it('says not paired when the site id has been cleared', () => {
    expect(
      deriveFooterState({
        status: healthy,
        statusFile: connected,
        config: { firebase: { enabled: true, site_id: '' } },
      }),
    ).toMatchObject({ label: 'not paired', tone: 'muted' })
  })

  it('reads the service’s own auth verdict rather than opening the token store', () => {
    const unauthenticated: ServiceStatusFile = {
      ...connected,
      firebase: { ...connected.firebase, connected: false },
      health: { status: 'auth_error', error_code: 'auth_error', error_message: 'token rejected' },
    }

    expect(
      deriveFooterState({ status: healthy, statusFile: unauthenticated, config: joined }),
    ).toMatchObject({
      label: 'authentication required',
      tone: 'warn',
      detail: 'token rejected',
    })
  })

  it('is disconnected when the service is up but not reaching owlette', () => {
    const offline: ServiceStatusFile = {
      ...connected,
      firebase: { ...connected.firebase, connected: false },
      health: { status: 'network_error', error_code: 'network_error', error_message: 'dns failed' },
    }

    expect(
      deriveFooterState({ status: healthy, statusFile: offline, config: joined }),
    ).toMatchObject({ label: 'disconnected', tone: 'error' })
  })

  it('does not claim a connection when the status file could not be read', () => {
    expect(
      deriveFooterState({ status: healthy, statusFile: null, config: joined }).label,
    ).toBe('disconnected')
  })
})

describe('site id', () => {
  it('prefers the config, which is what the service reads', () => {
    expect(siteIdOf({ firebase: { site_id: 'studio' } }, connected)).toBe('studio')
  })

  it('falls back to the status file before giving up', () => {
    expect(siteIdOf({ firebase: {} }, connected)).toBe('default_site')
    expect(siteIdOf(null, null)).toBe('')
  })
})

describe('site name', () => {
  const named: ServiceStatusFile = {
    ...connected,
    firebase: { ...connected.firebase, site_name: 'TEC' },
  }

  it('prefers the name the service published', () => {
    expect(siteNameOf(joined, named)).toBe('TEC')
  })

  it('falls back to the id, never to nothing', () => {
    expect(siteNameOf(joined, connected)).toBe('default_site')
    expect(siteNameOf(joined, { firebase: { site_id: 'default_site', site_name: '' } })).toBe(
      'default_site',
    )
    expect(siteNameOf(joined, null)).toBe('default_site')
  })

  it('ignores a name published for a site this machine has left', () => {
    // config.json is rewritten first on a join or a leave, so between that and
    // the service's next status write the file still names the old site.
    // Naming it would be worse than saying nothing about it.
    expect(siteNameOf({ firebase: { enabled: true, site_id: 'studio' } }, named)).toBe('studio')
  })

  it('has nothing to say about an unpaired machine', () => {
    expect(siteNameOf({ firebase: { enabled: false, site_id: '' } }, { firebase: {} })).toBe('')
  })

  it('trusts the status file before config.json has been read', () => {
    expect(siteNameOf(null, named)).toBe('TEC')
  })
})

describe('pairing', () => {
  it('needs both halves of the firebase block', () => {
    expect(isPaired(joined)).toBe(true)
    expect(isPaired({ firebase: { enabled: true, site_id: '' } })).toBe(false)
    expect(isPaired({ firebase: { enabled: false, site_id: 'default_site' } })).toBe(false)
    expect(isPaired({})).toBe(false)
  })

  it('answers neither way until config.json has been read', () => {
    // The menu and the footer both branch on this; a momentary `false` would
    // offer to pair a machine that is already paired.
    expect(isPaired(null)).toBeNull()
  })
})

describe('footer sentence', () => {
  const state = (label: string): FooterState => ({
    label,
    tone: 'ok',
    detail: null,
    serviceDown: false,
    action: 'none',
  })

  it('reads "<host> is connected to <site>"', () => {
    expect(footerSentence(state('connected'), 'default_site', 'TEC-A4D')).toEqual({
      before: 'TEC-A4D is ',
      after: ' to default_site',
    })
  })

  it('reads "<host> is disconnected from <site>"', () => {
    expect(footerSentence(state('disconnected'), 'default_site', 'TEC-A4D')).toEqual({
      before: 'TEC-A4D is ',
      after: ' from default_site',
    })
  })

  it('hangs the host off states that are not connection sentences', () => {
    expect(footerSentence(state('stopped'), '', 'TEC-A4D').after).toBe(' on TEC-A4D')
    expect(footerSentence(state('not responding'), '', 'TEC-A4D').after).toBe(' on TEC-A4D')
    expect(footerSentence(state('not installed'), '', 'TEC-A4D').after).toBe(' on TEC-A4D')
    expect(footerSentence(state('stopping'), '', 'TEC-A4D').after).toBe(' on TEC-A4D')
    expect(footerSentence(state('not paired'), '', 'TEC-A4D').before).toBe('TEC-A4D is ')
    expect(footerSentence(state('authentication required'), '', 'TEC-A4D').after).toBe(' for TEC-A4D')
  })

  it('leaves self-sufficient states alone', () => {
    expect(footerSentence(state('checking'), 'default_site', 'TEC-A4D')).toEqual({ before: '', after: '' })
  })

  it('falls back to the segment form until the hostname is known', () => {
    expect(footerSentence(state('connected'), 'default_site', null)).toEqual({
      before: '',
      after: ' · default_site',
    })
  })
})

describe('connecting…', () => {
  const stopped = { ...healthy, running: false, state: 'stopped' as const }
  const booting = { ...healthy, statusFile: { exists: true, ageSecs: 3_600, stale: true } }

  /**
   * The reported bug: relaunching after a quit finds the service stopped for a
   * beat before the auto-start lands, and the footer announced that beat as a
   * fault with a button to fix it.
   */
  it('says connecting, with no button, while a stopped service is being started', () => {
    expect(
      deriveFooterState({ status: stopped, statusFile: null, config: joined, bringingUp: true }),
    ).toMatchObject({ label: 'connecting…', tone: 'warn', serviceDown: false, action: 'none' })
  })

  it('offers start service only once nobody is bringing it up', () => {
    expect(
      deriveFooterState({ status: stopped, statusFile: null, config: joined, bringingUp: false }),
    ).toMatchObject({ label: 'stopped', tone: 'muted', action: 'start' })
  })

  it('covers the SCM start_pending phase without being told', () => {
    const startPending = { ...healthy, running: false, state: 'start_pending' as const }
    expect(
      deriveFooterState({ status: startPending, statusFile: null, config: joined }),
    ).toMatchObject({ label: 'connecting…', action: 'none' })
  })

  it('covers the agent still booting behind a RUNNING service', () => {
    expect(
      deriveFooterState({ status: booting, statusFile: null, config: joined, bringingUp: true }),
    ).toMatchObject({ label: 'connecting…', action: 'none' })
  })

  it('still calls a silent service wedged when no start is in progress', () => {
    expect(
      deriveFooterState({ status: booting, statusFile: null, config: joined, bringingUp: false }),
    ).toMatchObject({ label: 'not responding', tone: 'error', action: 'start' })
  })

  it('does not say connecting when the service is not installed', () => {
    const absent = { ...healthy, installed: false, running: false, state: 'unknown' as const }
    expect(
      deriveFooterState({ status: absent, statusFile: null, config: joined, bringingUp: true }),
    ).toMatchObject({ label: 'not installed', tone: 'error', action: 'start' })
  })

  it('reads as a sentence', () => {
    const state = deriveFooterState({
      status: stopped, statusFile: null, config: joined, bringingUp: true,
    })
    expect(footerSentence(state, 'TEC', 'TEC-A4D')).toEqual({
      before: 'TEC-A4D is ',
      after: ' to TEC',
    })
  })
})

/**
 * The colour scheme, as a contract rather than as whatever the branches happen
 * to return. Green = working, yellow = in transit or waiting on you, red =
 * something broke that nobody chose, grey = off on purpose or not known yet.
 */
describe('tone', () => {
  const stopped = { ...healthy, running: false, state: 'stopped' as const }
  const silent = { ...healthy, statusFile: { exists: true, ageSecs: 3_600, stale: true } }
  const absent = { ...healthy, installed: false, running: false, state: 'unknown' as const }
  const connected = { firebase: { enabled: true, connected: true, site_id: 'default_site' } }
  const offline = { firebase: { enabled: true, connected: false, site_id: 'default_site' } }

  const cases: Array<[string, FooterTone, FooterInputs]> = [
    ['connected', 'ok', { status: healthy, statusFile: connected, config: joined }],
    ['connecting…', 'warn', { status: stopped, statusFile: null, config: joined, bringingUp: true }],
    ['stopping', 'warn', {
      status: { ...healthy, running: false, state: 'stop_pending' }, statusFile: null, config: joined,
    }],
    ['stopped', 'muted', { status: stopped, statusFile: null, config: joined }],
    ['disconnected', 'error', { status: healthy, statusFile: offline, config: joined }],
    ['not responding', 'error', { status: silent, statusFile: connected, config: joined }],
    ['not installed', 'error', { status: absent, statusFile: null, config: joined }],
    ['checking', 'muted', { status: null, statusFile: null, config: joined }],
  ]

  it.each(cases)('%s is %s', (label, tone, inputs) => {
    const state = deriveFooterState(inputs)
    expect(state.label).toBe(label)
    expect(state.tone).toBe(tone)
  })

  it('gives every tone a text and a dot class', () => {
    for (const tone of ['ok', 'warn', 'error', 'muted'] as FooterTone[]) {
      expect(FOOTER_TONE_CLASS[tone]).toBeTruthy()
      expect(FOOTER_DOT_CLASS[tone]).toBeTruthy()
    }
  })
})

describe('why the service is down', () => {
  const down = (stoppedCleanly: boolean | null) => ({
    ...healthy, running: false, state: 'stopped' as const, stoppedCleanly,
  })

  /** A quit is grey; a crash nobody asked for is not. */
  it('separates a deliberate quit from a crash', () => {
    expect(
      deriveFooterState({ status: down(true), statusFile: null, config: joined }),
    ).toMatchObject({ label: 'stopped', tone: 'muted' })

    expect(
      deriveFooterState({ status: down(false), statusFile: null, config: joined }),
    ).toMatchObject({ label: 'stopped unexpectedly', tone: 'error', action: 'start' })
  })

  it('falls back to grey when the exit code is unknown', () => {
    expect(
      deriveFooterState({ status: down(null), statusFile: null, config: joined }),
    ).toMatchObject({ label: 'stopped', tone: 'muted' })
  })

  /** "checking" forever is a lie when the query is failing rather than pending. */
  it('says the service manager is unreachable rather than checking', () => {
    expect(
      deriveFooterState({ status: null, statusFile: null, config: joined }),
    ).toMatchObject({ label: 'checking' })

    expect(
      deriveFooterState({
        status: null, statusFile: null, config: joined,
        scmError: 'could not connect to the service manager',
      }),
    ).toMatchObject({ label: 'service manager unreachable', tone: 'muted', action: 'none' })
  })
})
