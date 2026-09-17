import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusFooter } from '@/components/StatusFooter'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ServiceStatus } from '@/lib/ipc'
import type { OwletteConfig } from '@/lib/owletteConfig'
import type { ServiceStatusFile } from '@/lib/serviceHealth'

const healthy: ServiceStatus = {
  installed: true,
  running: true,
  state: 'running',
  startType: 'auto_start',
  stoppedCleanly: null,
  statusFile: { exists: true, ageSecs: 12, stale: false },
}

const connected: ServiceStatusFile = {
  service: { running: true, last_update: 1_786_562_574, version: '3.0.0' },
  firebase: {
    enabled: true,
    connected: true,
    site_id: 'default_site',
    site_name: 'TEC',
    last_heartbeat: 0,
  },
  health: { status: 'ok', error_code: null, error_message: null },
}

/** What an agent that has not resolved the site's name publishes. */
const connectedUnnamed: ServiceStatusFile = {
  ...connected,
  firebase: { ...connected.firebase, site_name: '' },
}

const joined = { firebase: { enabled: true, site_id: 'default_site' } } as OwletteConfig

const unpaired = { firebase: { enabled: false, site_id: '' } } as OwletteConfig

/** Paired to the staging deployment `dev` auto-deploys to. */
const devConfig = {
  firebase: { enabled: true, site_id: 'default_site', api_base: 'https://dev.owlette.app/api' },
} as OwletteConfig

/** Paired to the real fleet — the case that must stay unbadged. */
const prodConfig = {
  firebase: { enabled: true, site_id: 'default_site', api_base: 'https://owlette.app/api' },
} as OwletteConfig

const serviceStopped: ServiceStatus = {
  installed: true,
  running: false,
  state: 'stopped',
  startType: 'auto_start',
  stoppedCleanly: null,
  statusFile: { exists: true, ageSecs: 400, stale: true },
}

function setup(overrides: Partial<Parameters<typeof StatusFooter>[0]> = {}) {
  const props = {
    status: healthy,
    statusFile: connected,
    config: joined,
    starting: false,
    onStart: vi.fn(),
    onJoin: vi.fn(),
    ...overrides,
  }
  render(
    <TooltipProvider>
      <StatusFooter {...props} />
    </TooltipProvider>,
  )
  return props
}

function joinButton(): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: 'join site' }) as HTMLButtonElement | null
}

describe('StatusFooter sentence', () => {
  it('names the site the way the operator does', () => {
    setup({ hostname: 'TEC-A4D' })
    expect(screen.getByTestId('footer-status').textContent).toBe('TEC-A4D is connected to TEC')
  })

  it('falls back to the site id when the service has published no name', () => {
    // Never blank, and never wrong: the id is still what this machine is
    // paired to, and it is what support will ask for.
    setup({ hostname: 'TEC-A4D', statusFile: connectedUnnamed })
    expect(screen.getByTestId('footer-status').textContent).toBe(
      'TEC-A4D is connected to default_site',
    )
  })

  it('falls back to the segment form while the host is unknown', () => {
    setup({ hostname: null })
    expect(screen.getByTestId('footer-status').textContent).toBe('connected · TEC')
  })

  it('shows the running service version on the right', () => {
    setup({ hostname: 'TEC-A4D' })
    expect(screen.getByText('v3.0.0')).toBeTruthy()
  })
})

describe('StatusFooter join site', () => {
  it('offers a way into a site when this machine belongs to none', () => {
    const props = setup({ config: unpaired, hostname: 'TEC-A4D' })

    // The sentence keeps saying what it said; the button is beside it.
    expect(screen.getByTestId('footer-status').textContent).toBe('TEC-A4D is not paired')
    fireEvent.click(joinButton() as HTMLButtonElement)
    expect(props.onJoin).toHaveBeenCalledOnce()
  })

  // A machine removed on the dashboard, a `leave site`, and a fresh install are
  // indistinguishable in config.json, so they all read the same way here.
  it('offers it to a machine whose site id has been cleared', () => {
    setup({
      config: { firebase: { enabled: true, site_id: '' } } as OwletteConfig,
      hostname: 'TEC-A4D',
    })

    expect(screen.getByTestId('footer-status').textContent).toBe('TEC-A4D is not paired')
    expect(joinButton()).toBeTruthy()
  })

  it('says nothing about joining a site this machine is already in', () => {
    setup({ hostname: 'TEC-A4D' })
    expect(joinButton()).toBeNull()
  })

  it('waits for config.json rather than flashing the button on startup', () => {
    setup({ config: null, hostname: 'TEC-A4D' })
    expect(joinButton()).toBeNull()
  })

  it('yields the slot to start service when nothing is supervising the machine', () => {
    // An unpaired machine with a dead service has one useful next step, and it
    // is not pairing.
    setup({ config: unpaired, status: serviceStopped, hostname: 'TEC-A4D' })

    expect(screen.getByRole('button', { name: 'start service' })).toBeTruthy()
    expect(joinButton()).toBeNull()
  })
})

describe('StatusFooter environment chip', () => {
  it('names the environment when this machine is paired to a non-production owlette', () => {
    setup({ config: devConfig, hostname: 'TEC-A4D' })

    expect(screen.getByTestId('footer-environment').textContent).toBe('dev')
    expect(screen.getByText('v3.0.0')).toBeTruthy()
  })

  it('badges nothing on production — an unlabelled footer is the real fleet', () => {
    setup({ config: prodConfig, hostname: 'TEC-A4D' })

    expect(screen.queryByTestId('footer-environment')).toBeNull()
    expect(screen.getByText('v3.0.0')).toBeTruthy()
  })

  it('badges nothing before config.json has been read', () => {
    // Absence is the production signal, so an unknown environment must not
    // guess — it stays silent until the file says otherwise.
    setup({ config: null, hostname: 'TEC-A4D' })

    expect(screen.queryByTestId('footer-environment')).toBeNull()
    expect(screen.getByText('v3.0.0')).toBeTruthy()
  })

  it('leaves the sentence to say the site, not the environment', () => {
    // The chip carries the deployment; `footerSentence` keeps its wording.
    setup({ config: devConfig, hostname: 'TEC-A4D' })

    expect(screen.getByTestId('footer-status').textContent).toBe('TEC-A4D is connected to TEC')
  })
})
