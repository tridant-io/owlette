/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * HootChatView — the wiring that makes multi-machine targeting visible.
 *
 * Four properties are on trial here, and each of them used to be the opposite:
 *
 * - **Ticking continues the conversation.** The old selector had exactly one
 *   way to change target — abandon the chat and start another — so the check
 *   that matters is that `startNewChat` is NOT called and the open chat is
 *   re-aimed in place (`retargetActiveChat`).
 * - **Changing SITE still starts one.** The active chat is bound to the old
 *   site and can't be sent to, so that path is unchanged (OWL-48).
 * - **A loaded chat's own selection wins**, and is adopted WITHOUT being
 *   written back as the user's preference; an unreadable one leaves the picker
 *   empty with send refused, never "all machines".
 * - **The single-machine path keys off the EFFECTIVE set**, so a one-machine
 *   site keeps the power toggle and the exact offline copy while the picker
 *   reads "all machines".
 *
 * The picker, the reducers and the composer are not on trial — their own suites
 * own them. Both are rendered for real anyway, because what is being tested is
 * that this screen passes them the right things and does the right thing with
 * what comes back.
 */
import React from 'react';
import { act, render, screen, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HootChatView } from '@/app/hoot/components/HootChatView';
import type { ChatConversation, ChatLoadedTarget } from '@/hooks/useHoot';
import type { HootTarget, ChatTargetType } from '@/lib/hoot/target';
import type { PlanResponse } from '@/lib/plan.server';

// jsdom ships no ResizeObserver; Radix's menu and popover positioning build one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Radix drives its trigger with pointer capture and scrolls the focused item
// into view; the conversation list scrolls itself to the top on a new chat.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollTo = jest.fn();
// The desktop/mobile branch is a JS media query, not a CSS one.
window.matchMedia = jest.fn().mockImplementation((query: string) => ({
  matches: true,
  media: query,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}));

interface MockMachine {
  machineId: string;
  online: boolean;
  cortexEnabled: boolean;
}

const SITE_A = { id: 'site-a', name: 'site a' };
const SITE_B = { id: 'site-b', name: 'site b' };

/** Three machines, so a single tick can never cover the site and collapse to "all". */
const THREE_MACHINES: MockMachine[] = [
  { machineId: 'kiosk-01', online: true, cortexEnabled: true },
  { machineId: 'kiosk-02', online: true, cortexEnabled: true },
  { machineId: 'kiosk-03', online: false, cortexEnabled: true },
];

const CHAT_ID = 'chat_live';

// Mutable fixtures. `mock`-prefixed so the jest.mock factories below may close
// over them (babel-plugin-jest-hoist allows exactly that).
let mockSites: { id: string; name: string; owner?: string }[] = [SITE_A, SITE_B];
let mockMachines: MockMachine[] = THREE_MACHINES;
/** Per-site override, for the cases where "which site is the header on" is the point. */
let mockMachinesBySite: Record<string, MockMachine[]> = {};
let mockConversations: ChatConversation[] = [];
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockUpdateLastMachine = jest.fn();
const mockUpdateLastSite = jest.fn();
let mockLastMachineIds: Record<string, string | string[]> = {};
let mockChatOptions:
  | { selection?: HootTarget; onChatLoaded?: (loaded: ChatLoadedTarget) => void }
  | null = null;

const mockChat = {
  chatId: CHAT_ID,
  messages: [],
  isLoading: false,
  error: null as Error | null,
  input: 'a question with something to send',
  setInput: jest.fn(),
  handleSend: jest.fn(),
  stop: jest.fn(),
  regenerate: jest.fn(),
  pendingImages: [],
  handlePasteImage: jest.fn(),
  removePendingImage: jest.fn(),
  addToolApprovalResponse: jest.fn(),
  editMessage: jest.fn(),
  toolCommands: {},
  cancelTool: jest.fn(),
  turnStale: false,
  turnRunning: false,
  followups: [] as { id: string; note: string; runAtMs: number | null }[],
  cancelFollowup: jest.fn(),
  chatLoadError: null as string | null,
  conversations: [] as ChatConversation[],
  loadingConversations: false,
  startNewChat: jest.fn(),
  retargetActiveChat: jest.fn(),
  loadChat: jest.fn(),
  deleteChat: jest.fn(),
  renameChat: jest.fn(),
  hasMoreConversations: false,
  loadingMore: false,
  loadMoreConversations: jest.fn(),
  updateConversationCategories: jest.fn(),
  searchQuery: '',
  setSearchQuery: jest.fn(),
};

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'user-1' },
    userSites: ['site-a', 'site-b'],
    isSuperadmin: true,
    isSiteAdmin: () => false,
    loading: false,
    lastSiteId: 'site-a',
    lastMachineIds: mockLastMachineIds,
    updateLastSite: mockUpdateLastSite,
    updateLastMachine: mockUpdateLastMachine,
  }),
}));

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites: mockSites, loading: false }),
  // Site-aware, because "the header followed the chat's site" is only visible
  // through the machines that site has.
  useMachines: (siteId: string) => ({
    machines: mockMachinesBySite[siteId] ?? mockMachines,
    loading: false,
  }),
}));

jest.mock('@/hooks/useHoot', () => ({
  useOwletteChat: (options: { onChatLoaded?: (loaded: ChatLoadedTarget) => void }) => {
    mockChatOptions = options;
    return { ...mockChat, conversations: mockConversations };
  },
}));

let mockCollapsedGroups = new Set<string>();
let mockPrefsHydrated = true;

jest.mock('@/hooks/useHootSidebarPrefs', () => ({
  useHootSidebarPrefs: () => ({
    sidebarOpen: true,
    setSidebarOpen: jest.fn(),
    collapsedGroups: mockCollapsedGroups,
    setCollapsedGroups: jest.fn(),
    sidebarWidth: 256,
    setSidebarWidth: jest.fn(),
    hydrated: mockPrefsHydrated,
  }),
  HOOT_SIDEBAR_DEFAULT_WIDTH: 256,
  HOOT_SIDEBAR_MIN_WIDTH: 180,
  HOOT_SIDEBAR_MAX_WIDTH: 480,
}));

// The site switcher lives in the shared header; this stands in for its menu, and
// reports which site the header is on — the only readout of that state.
jest.mock('@/components/PageHeader', () => ({
  PageHeader: ({
    currentSiteId,
    onSiteChange,
  }: {
    currentSiteId?: string;
    onSiteChange?: (siteId: string) => void;
  }) => (
    <div>
      <span data-testid="current-site">{currentSiteId}</span>
      <button type="button" onClick={() => onSiteChange?.('site-b')}>
        switch to site b
      </button>
    </div>
  ),
}));

jest.mock('@/components/AccountSettingsDialog', () => ({
  AccountSettingsDialog: () => null,
}));

jest.mock('@/app/hoot/components/ShareChatDialog', () => ({
  ShareChatDialog: () => null,
}));

// Stands in for the transcript, and reports the fallback label it was handed
// for messages that carry no per-turn metadata of their own, and whether it
// may offer suggestions and edits, which both send.
jest.mock('@/app/hoot/components/ChatWindow', () => ({
  ChatWindow: ({
    approvalTargetLabel,
    hideSuggestions,
    onEditMessage,
  }: {
    approvalTargetLabel?: string;
    hideSuggestions?: boolean;
    onEditMessage?: unknown;
  }) => (
    <div
      data-testid="chat-window"
      data-approval-target-label={approvalTargetLabel}
      data-hide-suggestions={String(Boolean(hideSuggestions))}
      data-can-edit={String(Boolean(onEditMessage))}
    />
  ),
}));

function renderView() {
  const user = userEvent.setup();
  const view: RenderResult = render(
    <TooltipProvider>
      <HootChatView />
    </TooltipProvider>,
  );
  /** Re-render with whatever the mutable fixtures now say (a late `sites`, a new chat id). */
  const rerender = () =>
    act(() => {
      view.rerender(
        <TooltipProvider>
          <HootChatView />
        </TooltipProvider>,
      );
    });
  return { user, rerender, trigger: screen.getByRole('button', { name: 'hoot target' }) };
}

async function openPicker() {
  const rendered = renderView();
  await rendered.user.click(rendered.trigger);
  await screen.findByRole('menu');
  return rendered;
}

function row(name: string) {
  return screen.getByRole('menuitemcheckbox', { name });
}

/**
 * The row's checkbox column — the half that TOGGLES within the ticked set.
 * Clicking the row anywhere else means "just this machine", so a test that means
 * to add or remove one has to hit this, exactly as a user does.
 */
function box(name: string): HTMLElement {
  const column = row(name).querySelector('[data-checkbox-box]');
  if (column === null) throw new Error(`row "${name}" has no checkbox column`);
  return column as HTMLElement;
}

/** Hand the screen a chat's stored target the way `loadChat` does. */
function loadChatWith(target: HootTarget | 'invalid', options?: { chatId?: string; siteId?: string }) {
  act(() => {
    mockChatOptions?.onChatLoaded?.({
      chatId: options?.chatId ?? CHAT_ID,
      siteId: options?.siteId ?? 'site-a',
      target,
    });
  });
}

function conversation(overrides: Partial<ChatConversation>): ChatConversation {
  return {
    id: 'convo-1',
    title: 'deployment triage',
    siteId: 'site-a',
    targetType: 'machine' as ChatTargetType,
    targetMachineIds: null,
    targetMachineId: null,
    machineName: null,
    source: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockSites = [SITE_A, SITE_B];
  mockMachines = THREE_MACHINES;
  mockMachinesBySite = {};
  mockConversations = [];
  mockLastMachineIds = {};
  mockChat.chatId = CHAT_ID;
  mockChatOptions = null;
  mockCollapsedGroups = new Set<string>();
  mockPrefsHydrated = true;
  mockPlan = undefined;
  mockChat.error = null;
});

describe('HootChatView conversation groups', () => {
  it('holds the list until the saved collapsed groups arrive, so a collapsed group never opens first', () => {
    mockConversations = [conversation({ id: 'convo-ops', title: 'cache cleanup', category: 'Operations' })];
    mockPrefsHydrated = false;
    const { rerender } = renderView();
    expect(screen.queryByText('cache cleanup')).not.toBeInTheDocument();

    mockCollapsedGroups = new Set(['Operations']);
    mockPrefsHydrated = true;
    rerender();
    expect(screen.getByRole('button', { name: /^operations/i })).toBeInTheDocument();
    expect(screen.queryByText('cache cleanup')).not.toBeInTheDocument();
  });

  it('keeps never-categorized conversations in their own unsorted group, after general', () => {
    mockConversations = [
      conversation({ id: 'convo-unsorted', title: 'kiosk reboot loop' }),
      conversation({ id: 'convo-general', title: 'hello there', category: 'General' }),
    ];
    renderView();

    const groups = screen.getAllByRole('button', { name: /^(general|unsorted)/i });
    expect(groups.map((g) => g.textContent)).toEqual(['General1', 'Unsorted1']);
    expect(screen.getByRole('button', { name: 'categorize 1 unsorted' })).toBeInTheDocument();
  });
});

describe('HootChatView target selection', () => {
  it('re-aims the open conversation when the ticked set changes, and never starts a new one', async () => {
    const { user, trigger } = await openPicker();
    expect(trigger).toHaveTextContent('all machines');

    await user.click(box('kiosk-03 offline'));

    // Unticking one machine spells the rest out — the same conversation, aimed
    // at fewer machines.
    expect(mockChat.retargetActiveChat).toHaveBeenCalledTimes(1);
    expect(mockChat.retargetActiveChat).toHaveBeenCalledWith({
      machineIds: ['kiosk-01', 'kiosk-02'],
    });
    expect(mockChat.startNewChat).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('kiosk-01, kiosk-02');
  });

  it('persists the new set as the site preference', async () => {
    const { user } = await openPicker();

    await user.click(box('kiosk-03 offline'));

    expect(mockUpdateLastMachine).toHaveBeenCalledWith('site-a', ['kiosk-01', 'kiosk-02']);
  });

  it('starts a new chat on a SITE change, aimed at that site stored selection', async () => {
    mockLastMachineIds = { 'site-b': ['edge-01', 'edge-02'] };
    const { user } = renderView();

    await user.click(screen.getByRole('button', { name: 'switch to site b' }));

    expect(mockUpdateLastSite).toHaveBeenCalledWith('site-b');
    expect(mockChat.startNewChat).toHaveBeenCalledWith({
      siteId: 'site-b',
      selection: { machineIds: ['edge-01', 'edge-02'] },
    });
    expect(mockChat.retargetActiveChat).not.toHaveBeenCalled();
  });

  it('adopts a loaded chat selection into the header without persisting it', async () => {
    renderView();

    loadChatWith({ machineIds: ['kiosk-02'] });

    expect(screen.getByRole('button', { name: 'hoot target' })).toHaveTextContent('kiosk-02');
    // Opening a conversation is not a change of preference.
    expect(mockUpdateLastMachine).not.toHaveBeenCalled();
  });

  it('leaves the picker empty and refuses to send when a chat target cannot be read', () => {
    renderView();

    loadChatWith('invalid');

    expect(
      screen.getByText('pick machines for this chat — its saved target could not be read'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'send message' })).toBeDisabled();
    // Emphatically NOT "all machines": an unreadable target must not widen.
    const trigger = screen.getByRole('button', { name: 'hoot target' });
    expect(trigger).toHaveTextContent('no machines');
    expect(trigger).not.toHaveTextContent('all machines');
  });

  it('sends again once the user picks machines for an unreadable chat', async () => {
    const { user } = renderView();
    loadChatWith('invalid');

    await user.click(screen.getByRole('button', { name: 'hoot target' }));
    await screen.findByRole('menu');
    await user.click(row('kiosk-01'));
    // The open menu hides the rest of the page from the a11y tree (Radix marks
    // its siblings aria-hidden), which is also why picking is a click, not a
    // click per machine and a reopen.
    await user.keyboard('{Escape}');

    expect(mockChat.retargetActiveChat).toHaveBeenCalledWith({ machineIds: ['kiosk-01'] });
    expect(screen.getByRole('button', { name: 'send message' })).toBeEnabled();
  });

  it('follows a deep-linked chat from another site in the header, without starting a chat', () => {
    renderView();

    loadChatWith({ machineIds: null }, { siteId: 'site-b' });

    expect(screen.getByTestId('current-site')).toHaveTextContent('site-b');
    expect(mockChat.startNewChat).not.toHaveBeenCalled();
    expect(mockUpdateLastSite).not.toHaveBeenCalled();
  });

  it('follows it even when the chat loads BEFORE the sites listing does', () => {
    // The cold-load ordering: a chat read is one Firestore hop and fires on
    // mount, `useSites` is two behind it. Dropping the site here used to leave
    // the header on `lastSiteId` and prune the chat's own machines away against
    // it — an open conversation that could not be sent to.
    mockSites = [];
    mockMachinesBySite = {
      'site-a': THREE_MACHINES,
      // Two, so one ticked id stays an explicit subset instead of collapsing
      // back to the dynamic "all machines" a one-machine site reads as.
      'site-b': [
        { machineId: 'edge-01', online: true, cortexEnabled: true },
        { machineId: 'edge-02', online: true, cortexEnabled: true },
      ],
    };
    const { rerender } = renderView();

    loadChatWith({ machineIds: ['edge-01'] }, { siteId: 'site-b' });
    mockSites = [SITE_A, SITE_B];
    rerender();

    expect(screen.getByTestId('current-site')).toHaveTextContent('site-b');
    expect(screen.getByRole('button', { name: 'hoot target' })).toHaveTextContent('edge-01');
    expect(screen.getByRole('button', { name: 'send message' })).toBeEnabled();
    expect(mockChat.startNewChat).not.toHaveBeenCalled();
    expect(mockUpdateLastSite).not.toHaveBeenCalled();
  });

  it('re-aims the open chat when a ticked machine has left the site', () => {
    renderView();

    // The pin is what a send is addressed with, and nothing else re-reads it:
    // an id the site no longer has would sit there 400ing every turn while the
    // picker showed only the survivors.
    loadChatWith({ machineIds: ['kiosk-01', 'decommissioned-09'] });

    expect(mockChat.retargetActiveChat).toHaveBeenCalledWith({ machineIds: ['kiosk-01'] });
    expect(screen.getByRole('button', { name: 'hoot target' })).toHaveTextContent('kiosk-01');
    // Adopting a chat's target is still not a change of preference.
    expect(mockUpdateLastMachine).not.toHaveBeenCalled();
  });

  it('leaves an unreadable chat pinned rather than re-aiming it', () => {
    renderView();

    loadChatWith('invalid');

    // The fail-closed `'invalid'` pin outranks anything the header holds.
    expect(mockChat.retargetActiveChat).not.toHaveBeenCalled();
  });

  it('starts the next conversation from the site selection, not the unreadable chat empty picker', () => {
    mockLastMachineIds = { 'site-a': ['kiosk-01', 'kiosk-02'] };
    const { rerender } = renderView();

    loadChatWith('invalid');
    expect(screen.getByRole('button', { name: 'hoot target' })).toHaveTextContent('no machines');
    // What a new chat is pinned from — the landing reset and `deleteChat` start
    // one without going through `handleNewChat`, so this value is the only thing
    // standing between them and a brand-new chat nothing is ticked for.
    expect(mockChatOptions?.selection).toEqual({ machineIds: ['kiosk-01', 'kiosk-02'] });

    // Browser-back / delete: same screen, different chat.
    mockChat.chatId = 'chat_fresh';
    rerender();

    expect(screen.getByRole('button', { name: 'hoot target' })).toHaveTextContent(
      'kiosk-01, kiosk-02',
    );
    expect(screen.getByRole('button', { name: 'send message' })).toBeEnabled();
    expect(screen.queryByText(/saved target could not be read/)).toBeNull();
  });

  it('disables send while nothing is ticked, and stores nothing (D-G)', async () => {
    const { user } = await openPicker();

    // The master row is tri-state, and its BOX is the checkbox half: from
    // everything ticked it clears. (Its name means "talk to everything", which
    // is the one thing that cannot leave the picker empty.)
    await user.click(box('all machines 2 online'));
    await user.keyboard('{Escape}');

    expect(screen.getByText('pick at least one machine to send')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'send message' })).toBeDisabled();
    expect(mockUpdateLastMachine).not.toHaveBeenCalled();
    // Still the same conversation, now aimed at nothing.
    expect(mockChat.startNewChat).not.toHaveBeenCalled();
    expect(mockChat.retargetActiveChat).toHaveBeenCalledWith({ machineIds: [] });
  });
});

describe('HootChatView single-machine affordances', () => {
  it('keeps the power toggle and the offline copy on a ONE-MACHINE site showing "all machines"', () => {
    mockMachines = [{ machineId: 'only-01', online: false, cortexEnabled: true }];
    const { trigger } = renderView();

    expect(trigger).toHaveTextContent('all machines');
    // effectiveFanOut: "all" over one machine IS that machine.
    expect(screen.getByText('hoot active')).toBeInTheDocument();
    expect(
      screen.getByText('machine is offline — tool calls will not be delivered'),
    ).toBeInTheDocument();
  });

  it('shows the power toggle for one explicitly ticked machine', () => {
    renderView();

    loadChatWith({ machineIds: ['kiosk-01'] });

    expect(screen.getByText('hoot active')).toBeInTheDocument();
  });

  it('hides the power toggle once a turn would fan out', () => {
    renderView();

    loadChatWith({ machineIds: ['kiosk-01', 'kiosk-02'] });

    expect(screen.queryByText('hoot active')).toBeNull();
  });
});

describe('HootChatView set-aware warnings', () => {
  it('counts the machines a fan-out will skip', () => {
    renderView();

    // kiosk-03 is offline; the other two are reachable.
    expect(
      screen.getByText('1 of 3 machines will be skipped — offline or hoot off'),
    ).toBeInTheDocument();
  });

  it('warns when no targeted machine is online', () => {
    mockMachines = [
      { machineId: 'kiosk-01', online: false, cortexEnabled: true },
      { machineId: 'kiosk-02', online: false, cortexEnabled: true },
    ];
    renderView();

    expect(
      screen.getByText('no machines online — tool calls will not be delivered'),
    ).toBeInTheDocument();
  });

  it('distinguishes an online machine with hoot switched off', () => {
    mockMachines = [
      { machineId: 'kiosk-01', online: true, cortexEnabled: false },
      { machineId: 'kiosk-02', online: false, cortexEnabled: true },
    ];
    renderView();

    expect(
      screen.getByText('no machines with hoot on are online — tool calls will not be delivered'),
    ).toBeInTheDocument();
  });

  it('says nothing while the site machines are still unknown', () => {
    mockMachines = [];
    renderView();

    expect(screen.queryByText(/tool calls will not be delivered/)).toBeNull();
  });
});

describe('HootChatView labels', () => {
  it('labels older approval cards with the current selection', async () => {
    const { user } = await openPicker();
    await user.click(box('kiosk-03 offline'));

    expect(screen.getByTestId('chat-window')).toHaveAttribute(
      'data-approval-target-label',
      'kiosk-01, kiosk-02',
    );
  });

  it('labels a multi-machine conversation row with its own stored set', () => {
    mockConversations = [
      conversation({
        targetType: 'machines',
        targetMachineIds: ['kiosk-01', 'kiosk-02', 'kiosk-03'],
        machineName: 'kiosk-01, kiosk-02 +1',
      }),
    ];
    renderView();

    // Scoped to the row: the picker's trigger carries a label of its own.
    expect(screen.getByRole('button', { name: /^deployment triage/ })).toHaveTextContent(
      'kiosk-01, kiosk-02 +1',
    );
  });

  it('keeps a single-machine conversation row on its stored display name', () => {
    // A talon machine chat stores `LOBBY-01`, not the hostname it dispatches to,
    // and that label is what the chat carries everywhere else it appears.
    mockConversations = [
      conversation({
        targetType: 'machine',
        targetMachineIds: ['lobby-pc-01'],
        targetMachineId: 'lobby-pc-01',
        machineName: 'LOBBY-01',
      }),
    ];
    renderView();

    expect(screen.getByRole('button', { name: /^deployment triage/ })).toHaveTextContent('LOBBY-01');
  });

  it('labels a site-wide conversation row "all machines"', () => {
    mockConversations = [conversation({ targetType: 'site', machineName: 'All Machines' })];
    renderView();

    expect(screen.getByRole('button', { name: /^deployment triage/ })).toHaveTextContent(
      'all machines',
    );
  });
});

const ALL_FLAGS: PlanResponse['flags'] = {
  control: true,
  deployments: true,
  swoop: true,
  hoot: true,
  roost: true,
  talons: true,
  webhooks: true,
  api_keys: true,
};
const CORE_PLAN: PlanResponse = {
  enforced: true,
  plan: 'core',
  standing: 'active',
  limits: { machines: null, sites: 1 },
  flags: { ...ALL_FLAGS, deployments: false, swoop: false, hoot: false, roost: false, talons: false, webhooks: false, api_keys: false },
  activeMachinesThisMonth: 3,
};

describe('HootChatView plan', () => {
  it("shows a refusal's problem detail, not its raw json", () => {
    mockChat.error = new Error(
      JSON.stringify({
        type: 'https://owlette.app/docs/api/errors#plan_required',
        title: 'Payment Required',
        status: 402,
        detail: "your plan doesn't include hoot. upgrade to continue.",
        code: 'plan_required',
      }),
    );
    renderView();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("your plan doesn't include hoot. upgrade to continue.");
    expect(alert).not.toHaveTextContent('plan_required');
  });

  it("puts the upgrade note where the composer was on the viewer's own site", () => {
    mockPlan = CORE_PLAN;
    mockSites = [{ ...SITE_A, owner: 'user-1' }, SITE_B];
    renderView();

    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent("your plan doesn't include hoot.");
    expect(document.querySelector('[data-chat-input]')).toBeNull();
    const transcript = screen.getByTestId('chat-window');
    expect(transcript).toHaveAttribute('data-hide-suggestions', 'true');
    expect(transcript).toHaveAttribute('data-can-edit', 'false');
  });

  it('keeps the composer on a site another account pays for', () => {
    mockPlan = CORE_PLAN;
    mockSites = [{ ...SITE_A, owner: 'someone-else' }, SITE_B];
    renderView();

    expect(screen.queryByTestId('upgrade-gate-inline')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-input]')).not.toBeNull();
    expect(screen.getByTestId('chat-window')).toHaveAttribute('data-can-edit', 'true');
  });
});
