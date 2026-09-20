'use client';

import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines, useSites, type LaunchMode, type ScheduleBlock } from '@/hooks/useFirestore';
import { DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults';
import { scheduleClockLabel } from '@/lib/scheduleClockCopy';
import { useSchedulePresets } from '@/hooks/useSchedulePresets';
import { useDeployments } from '@/hooks/useDeployments';
import { useMachineOperations } from '@/hooks/useMachineOperations';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import { useAgentAlertToasts, type ExeMissingToastAlert } from '@/hooks/useAgentAlertToasts';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { Plus, LayoutGrid, List, ChevronsUpDown, ChevronsDownUp, Square, Copy, Trash2, Download, Monitor, Cog, Settings2, RotateCw, Loader2, CheckCircle2, Clock } from 'lucide-react';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Table, TableBody } from '@/components/ui/table';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import DownloadButton from '@/components/DownloadButton';
import { RemoveMachineDialog } from '@/components/RemoveMachineDialog';
import { ScreenshotDialog } from '@/components/ScreenshotDialog';
import { LiveViewModal } from '@/components/LiveViewModal';
import { PageHeader } from '@/components/PageHeader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
// Imported from the lightweight module, not @/components/charts' barrel, which would
// pull Recharts-heavy components into the dashboard bundle.
import { deserializeTabs, initialMetricToState, serializeTabs } from '@/components/charts/metricsTabs';
import type { MetricType } from '@/components/charts/ChartTooltip';
import ScheduleEditor, { ScheduleBlocksEditor } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import { MachineCardView } from './components/MachineCardView';
import { MachineRow, MachineTableHeader, type DeviceUnion, type ShowDropdownFlags } from './components/MachineListView';
import { useDevicePrefs } from '@/hooks/useDevicePrefs';
import { useSlidePanel } from '@/hooks/useSlidePanel';
import { unionIds } from '@/lib/deviceResolvers';
import { nextDuplicateName } from '@/lib/processNaming';
import { AddMachineButton } from './components/AddMachineButton';
import { SiteTimeConfirmBanner } from './components/SiteTimeConfirmBanner';
import { useDeviceCodeAuthorize } from '@/hooks/useDeviceCodeAuthorize';
import { LoadingWord } from '@/components/LoadingWord';
import { FallingFeather } from '@/components/FallingFeather';
import type { Process } from '@/hooks/useFirestore';
import { useScrollFade } from '@/hooks/useScrollFade';

// Code-split: deferring parse+compile of the detail panels until a cell is clicked keeps
// the grid-template-rows slide animation inside its frame budget. `ssr: false` because
// both subscribe to live Firestore state — nothing to server-render.
const MetricsDetailPanel = dynamic(
  () => import('@/components/charts/MetricsDetailPanel').then((m) => ({ default: m.MetricsDetailPanel })),
  { ssr: false, loading: () => null },
);
const DisplayLayoutPanel = dynamic(
  () => import('@/components/charts/DisplayLayoutPanel').then((m) => ({ default: m.DisplayLayoutPanel })),
  { ssr: false, loading: () => null },
);

type ViewType = 'card' | 'list';

interface DetailPanelState {
  machineId: string;
  machineName: string;
  metric: MetricType;
}

export default function DashboardPage() {
  // The form dissolves under the dialog header instead of being cut by it — with the
  // schedule section open it outgrows a laptop viewport.
  const processFormRef = useScrollFade<HTMLDivElement>();

  const router = useRouter();
  const { user, loading, isSuperadmin, isSiteAdmin, userSites, lastSiteId, updateLastSite, requiresMfaSetup, userPreferences, updateUserPreferences } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isSuperadmin);
  const { version, downloadUrl } = useInstallerVersion();
  // One fetch per mount (the hook never polls), gated on auth resolving so it doesn't
  // fire a request the session cookie can only 401.
  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [viewType, setViewType] = useState<ViewType>('card');
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);

  // Lifted so the card-header "+" and step 3's "generate code" link drive the same modal
  // on different tabs.
  const [addMachineOpen, setAddMachineOpen] = useState(false);
  const [addMachineTab, setAddMachineTab] = useState<'enter' | 'generate'>('enter');
  // Inline 3-word-phrase authorize; shares AddMachineButton's "enter code" implementation.
  const emptyStateAuthorize = useDeviceCodeAuthorize(currentSiteId);


  // Single editor instance, opened by the gear icon on any process.
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [scheduleEditorTarget, setScheduleEditorTarget] = useState<{ machineId: string; process: Process } | null>(null);

  const handleConfigureSchedule = (machineId: string, process: Process) => {
    setScheduleEditorTarget({ machineId, process });
    setScheduleEditorOpen(true);
  };

  const handleScheduleApply = (schedules: ScheduleBlock[], presetId: string | null) => {
    if (scheduleEditorTarget) {
      const { machineId, process } = scheduleEditorTarget;
      const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as 'off' | 'always' | 'scheduled';
      handleSetLaunchMode(machineId, process.id, process.name, currentMode, process.exe_path, schedules, presetId, `Schedule saved for "${process.name}"`);
    }
    setScheduleEditorOpen(false);
    setScheduleEditorTarget(null);
  };

  const handleCreatePreset = async (name: string, blocks: ScheduleBlock[]) => {
    if (!user?.uid) return;
    await createPreset({
      name,
      blocks,
      isBuiltIn: false,
      order: 99,
      createdBy: user.uid,
    });
    toast.success(`Preset "${name}" saved`);
  };

  const [processDialogOpen, setProcessDialogOpen] = useState(false);
  const [processDialogMode, setProcessDialogMode] = useState<'create' | 'edit'>('edit');
  const [editingMachineId, setEditingMachineId] = useState<string>('');
  const [editingProcessId, setEditingProcessId] = useState<string>('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editProcessForm, setEditProcessForm] = useState<{
    name: string; exe_path: string; file_path: string; cwd: string;
    priority: string; visibility: string; time_delay: string; time_to_init: string;
    relaunch_attempts: string; autolaunch: boolean; launch_mode: LaunchMode; schedules: ScheduleBlock[] | null;
  }>({
    name: '',
    exe_path: '',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    autolaunch: false,
    launch_mode: 'off',
    schedules: null,
  });
  // The schedule is editable in every launch mode (matching the desktop app): from
  // off/always this pre-configures windows without changing the mode. In `scheduled` the
  // section is pinned open, so this flag only drives the other two.
  const [scheduleSectionOpen, setScheduleSectionOpen] = useState(false);
  const scheduleSectionVisible = editProcessForm.launch_mode === 'scheduled' || scheduleSectionOpen;
  // Prefill defaults when nothing is stored so the summary bar and editor agree; nothing
  // is written to the form until the user edits a block.
  const scheduleBlocks = editProcessForm.schedules && editProcessForm.schedules.length > 0
    ? editProcessForm.schedules
    : DEFAULT_SCHEDULE;

  const { machines, loading: machinesLoading, killProcess, setLaunchMode, updateProcess, deleteProcess, createProcess, restartMachine, shutdownMachine, cancelRestart, dismissRestartPending, captureScreenshot, startLiveView, stopLiveView } = useMachines(currentSiteId);
  const { prefs: devicePrefs, setListPref } = useDevicePrefs();
  const listPref = devicePrefs.listView;
  const deviceUnion = useMemo<DeviceUnion>(() => ({
    cpus:  unionIds(machines.map(m => m.devices?.cpus?.map(c => c.id) ?? [])),
    disks: unionIds(machines.map(m => m.devices?.disks?.map(d => d.id) ?? [])),
    gpus:  unionIds(machines.map(m => m.devices?.gpus?.map(g => g.id) ?? [])),
    nics:  unionIds(machines.map(m => m.devices?.nics?.map(n => n.id) ?? [])),
  }), [machines]);
  const showDropdown = useMemo<ShowDropdownFlags>(() => ({
    cpu:  machines.some(m => (m.devices?.cpus?.length  ?? 0) > 1),
    disk: machines.some(m => (m.devices?.disks?.length ?? 0) > 1),
    gpu:  machines.some(m => (m.devices?.gpus?.length  ?? 0) > 1),
    nic:  machines.some(m => (m.devices?.nics?.length  ?? 0) > 1),
  }), [machines]);
  const { presets: schedulePresets, createPreset, deletePreset: deleteSchedulePreset, updatePreset: updateSchedulePreset } = useSchedulePresets(currentSiteId);
  const { checkMachineHasActiveDeployment } = useDeployments(currentSiteId);
  const { removeMachineFromSite, removing: isRemovingMachine } = useMachineOperations(currentSiteId);

  const [expandedMachineIds, setExpandedMachineIds] = useState<Set<string>>(() => new Set());

  // Keyed on machines.length, not `machines` — otherwise every metrics snapshot that
  // mutates an existing machine re-runs this.
  useEffect(() => {
    if (userPreferences.processesExpanded) {
      setExpandedMachineIds(new Set(machines.map(m => m.machineId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines.length, userPreferences.processesExpanded]);

  const [removeMachineDialogOpen, setRemoveMachineDialogOpen] = useState(false);
  const [machineToRemove, setMachineToRemove] = useState<{ id: string; name: string; isOnline: boolean } | null>(null);

  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killTarget, setKillTarget] = useState<{ machineId: string; processId: string; processName: string } | null>(null);

  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartTarget, setRestartTarget] = useState<{ machineId: string; processId: string; processName: string } | null>(null);
  const [restartInFlight, setRestartInFlight] = useState(false);

  const [screenshotDialogOpen, setScreenshotDialogOpen] = useState(false);
  const [screenshotTarget, setScreenshotTarget] = useState<{ machineId: string; machineName: string; isOnline: boolean } | null>(null);

  const [liveViewOpen, setLiveViewOpen] = useState(false);
  const [liveViewTarget, setLiveViewTarget] = useState<{ machineId: string; machineName: string } | null>(null);

  // A live "clear all" keeps the panel open, but an empty selection restored from a
  // previous session must NOT reopen it — that reserves an empty slide and pushes the
  // machines list below the page header (recurring regression). This ref flips true only
  // once the panel has been open this session.
  const panelOpenedThisSessionRef = useRef(false);

  const detailPanel = useMemo<DetailPanelState | null>(() => {
    const p = userPreferences.activeGraphPanel;
    if (!p) return null;
    // Don't restore a panel for a machine that isn't in the current site.
    if (!machines.some(m => m.machineId === p.machineId)) return null;
    if (p.metric !== 'display') {
      const persisted = userPreferences.graphTabs?.[p.machineId];
      if (persisted !== undefined) {
        const sel = deserializeTabs(persisted);
        const hasAny = sel.metrics.length || sel.nics.length || sel.disks.length || sel.gpus.length || sel.diskIO.length;
        // Empty selection stays mounted only if opened live this session (clear-all).
        if (!hasAny && !panelOpenedThisSessionRef.current) return null;
      }
    }
    return { machineId: p.machineId, machineName: p.machineId, metric: p.metric as MetricType };
  }, [userPreferences.activeGraphPanel, userPreferences.graphTabs, machines]);

  // Mark open-this-session once it resolves non-null, so a later clear-all keeps it open.
  useEffect(() => {
    if (detailPanel) panelOpenedThisSessionRef.current = true;
  }, [detailPanel]);

  // Height slide on open/close and machine swap. Tab switches and display↔metric swaps
  // are silent / reflow-driven — see `useSlidePanel`.
  const {
    wrapperRef: slideWrapperRef,
    contentRef: slideContentRef,
    held: heldDetailPanel,
    slideAnimating,
  } = useSlidePanel<DetailPanelState>({
    value: detailPanel,
    reanimateKey: (p) => p.machineId,
    reflowKey: (p) => (p.metric === 'display' ? 'display' : 'metric'),
  });

  const welcomeMessages = useMemo(() => [
    // English (heavy)
    { text: "Welcome back", language: "English", translation: "Welcome back" },
    { text: "Greetings", language: "English", translation: "Greetings" },
    { text: "Hey there", language: "English (casual)", translation: "Hey there" },
    { text: "Good to see you", language: "English", translation: "Good to see you" },
    { text: "Hello again", language: "English", translation: "Hello again" },
    { text: "Welcome", language: "English", translation: "Welcome" },
    { text: "Howdy", language: "English (Southern US)", translation: "Howdy" },
    { text: "What's up", language: "English (casual)", translation: "What's up" },
    { text: "G'day", language: "English (Australian)", translation: "G'day / Good day" },
    { text: "Cheers", language: "English (British)", translation: "Cheers / Hello" },

    // Spanish (heavy)
    { text: "Bienvenido", language: "Spanish", translation: "Welcome" },
    { text: "Hola de nuevo", language: "Spanish", translation: "Hello again" },
    { text: "Qué tal", language: "Spanish (casual)", translation: "What's up / How's it going" },
    { text: "Saludos", language: "Spanish", translation: "Greetings" },
    { text: "Buenas", language: "Spanish (casual)", translation: "Hey / Hi there" },
    { text: "Hola", language: "Spanish", translation: "Hello" },
    { text: "Bienvenido de vuelta", language: "Spanish", translation: "Welcome back" },
    { text: "Qué onda", language: "Spanish (Mexican)", translation: "What's up" },
    { text: "¿Cómo estás?", language: "Spanish", translation: "How are you?" },
    { text: "Encantado de verte", language: "Spanish", translation: "Pleased to see you" },

    // French
    { text: "Bienvenue", language: "French", translation: "Welcome" },
    { text: "Salut", language: "French (casual)", translation: "Hi" },
    { text: "Bon retour", language: "French", translation: "Good return / Welcome back" },

    // German
    { text: "Willkommen zurück", language: "German", translation: "Welcome back" },
    { text: "Hallo", language: "German", translation: "Hello" },
    { text: "Grüß dich", language: "German (casual)", translation: "Greetings to you" },

    // Italian
    { text: "Benvenuto", language: "Italian", translation: "Welcome" },
    { text: "Ciao", language: "Italian", translation: "Hi / Bye" },

    // Portuguese
    { text: "Bem-vindo de volta", language: "Portuguese", translation: "Welcome back" },
    { text: "Olá", language: "Portuguese", translation: "Hello" },

    // Dutch
    { text: "Welkom terug", language: "Dutch", translation: "Welcome back" },

    // Russian
    { text: "Добро пожаловать", language: "Russian", translation: "Welcome" },
    { text: "Привет", language: "Russian", translation: "Hi" },

    // Asian languages
    { text: "欢迎回来", language: "Chinese (Simplified)", translation: "Welcome back" },
    { text: "ようこそ", language: "Japanese", translation: "Welcome" },
    { text: "환영합니다", language: "Korean", translation: "Welcome" },
    { text: "स्वागत है", language: "Hindi", translation: "Welcome" },
    { text: "ยินดีต้อนรับกลับมา", language: "Thai", translation: "Welcome back" },
    { text: "Chào mừng trở lại", language: "Vietnamese", translation: "Welcome back" },

    // Middle Eastern
    { text: "مرحبا بعودتك", language: "Arabic", translation: "Welcome back" },
    { text: "ברוך השב", language: "Hebrew", translation: "Blessed is the return" },
    { text: "Hoş geldin", language: "Turkish", translation: "Welcome" },

    // Scandinavian
    { text: "Välkommen tillbaka", language: "Swedish", translation: "Welcome back" },
    { text: "Velkommen tilbage", language: "Danish", translation: "Welcome back" },
    { text: "Velkommen tilbake", language: "Norwegian", translation: "Welcome back" },
    { text: "Tervetuloa takaisin", language: "Finnish", translation: "Welcome back" },

    // Other European
    { text: "Witaj ponownie", language: "Polish", translation: "Welcome again" },
    { text: "Vítejte zpět", language: "Czech", translation: "Welcome back" },
    { text: "Καλώς ήρθες πάλι", language: "Greek", translation: "Welcome back" },
    { text: "Bine ai revenit", language: "Romanian", translation: "Good you returned" },

    // Southeast Asian
    { text: "Selamat datang kembali", language: "Indonesian", translation: "Safe arrival back" },
    { text: "Maligayang pagbabalik", language: "Filipino", translation: "Happy return" },

    // Celtic
    { text: "Fàilte air ais", language: "Scottish Gaelic", translation: "Welcome back" },
    { text: "Croeso yn ôl", language: "Welsh", translation: "Welcome back" },
    { text: "Fáilte ar ais", language: "Irish", translation: "Welcome back" },
  ], []);

  const techJokes = useMemo(() => [
"Your pixels are in good hands",
"Keeping your GPUs well-fed and happy",
"Because Ctrl+Alt+Delete is so 2000s",
"Herding your processes since 2025",
"Making sure your renders don't surrender",
"Your CPU's personal trainer",
"We put the 'auto' in autolaunch",
"Babysitting processes so you don't have to",
"Keeping the frames flowing",
"Process management: Now streaming",
"Your digital janitor service",
"Making computers computier since 2025",
"Because someone has to babysit your GPUs",
"Turning crashes into... well, less crashes",
"Your processes' favorite nanny",
"We'll handle the restarts, you handle the art",
"Keeping your render farm from going on strike",
"Process wrangling at its finest",
"Making sure your video doesn't get stagefright",
"Your machines' remote control, literally",
"Teaching old GPUs new tricks",
"We don't judge your 47 Chrome tabs",
"Remotely judging your cable management",
"Making Windows behave since 2025",
"Your processes called, they want a manager",
"Turning blue screens into green lights",
"The cloud's favorite floor manager",
"Because 'Have you tried turning it off and on again?' gets old",
"Your GPU's therapist",
"Making sure your RAM doesn't feel lonely",
"Process management with extra cheese",
"We put the 'service' in Windows Service",
"Keeping your video walls from having a meltdown",
"Because manual restarts are for peasants",
"Your installation's guardian angel",
"Making TouchDesigner touch easier",
"Render farm to table, fresh processes daily",
"We speak fluent GPU",
"Your digital signage's best friend",
"Because someone needs to watch the watchers",
"Turning 'It works on my machine' into reality",
"Process therapy, cloud edition",
"Making Resolume resolve to stay running",
"Your kiosk's remote babysitter",
"Because uptime is updog",
"GPU whisperer extraordinaire",
"Making your media servers less dramatic",
"We've seen things... running things",
"Your process's life coach",
"Because closing Task Manager won't fix this",
"Keeping your renders rendering since 2025",
"The owl watches over your processes",
"Making Windows services less mysterious",
"Your exhibition's technical director",
"Process management: It's not rocket science, it's harder"
  ], []);

  const [randomWelcome] = useState(() => welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]);
  const [randomJoke] = useState(() => techJokes[Math.floor(Math.random() * techJokes.length)]);

  const toggleStatsExpanded = useCallback(() => {
    updateUserPreferences({ statsExpanded: !userPreferences.statsExpanded }, { silent: true });
  }, [userPreferences.statsExpanded, updateUserPreferences]);

  const toggleProcessesExpanded = useCallback(() => {
    updateUserPreferences({ processesExpanded: !userPreferences.processesExpanded }, { silent: true });
  }, [userPreferences.processesExpanded, updateUserPreferences]);

  const toggleDisplaysExpanded = useCallback(() => {
    updateUserPreferences({ displaysExpanded: !userPreferences.displaysExpanded }, { silent: true });
  }, [userPreferences.displaysExpanded, updateUserPreferences]);

  const allExpanded = expandedMachineIds.size === machines.length && machines.length > 0;

  const toggleAllExpanded = useCallback(() => {
    if (allExpanded) {
      setExpandedMachineIds(new Set());
      updateUserPreferences({ statsExpanded: false, processesExpanded: false, displaysExpanded: false }, { silent: true });
    } else {
      setExpandedMachineIds(new Set(machines.map(m => m.machineId)));
      updateUserPreferences({ statsExpanded: true, processesExpanded: true, displaysExpanded: true }, { silent: true });
    }
  }, [allExpanded, machines, updateUserPreferences]);

  const toggleMachineExpanded = useCallback((machineId: string) => {
    setExpandedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const handleKillProcess = (machineId: string, processId: string, processName: string) => {
    setKillTarget({ machineId, processId, processName });
    setKillConfirmOpen(true);
  };

  const confirmKillProcess = async () => {
    if (!killTarget) return;
    const { machineId, processId, processName } = killTarget;
    setKillConfirmOpen(false);
    setKillTarget(null);
    try {
      await killProcess(machineId, processId, processName);
      toast.success(`Kill command sent for "${processName}"`);
    } catch (error: unknown) {
      console.error('confirmKillProcess error:', error);
      const msg = error instanceof Error ? error.message : 'Failed to kill process';
      toast.error(msg);
    }
  };

  const handleRestartProcess = (machineId: string, processId: string, processName: string) => {
    setRestartTarget({ machineId, processId, processName });
    setRestartConfirmOpen(true);
  };

  const confirmRestartProcess = async () => {
    if (!restartTarget) return;
    const { machineId, processId, processName } = restartTarget;
    setRestartInFlight(true);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(currentSiteId)}/machines/${encodeURIComponent(machineId)}/processes/${encodeURIComponent(processId)}/restart`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
        },
      );
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(body?.detail || body?.title || `Request failed with ${res.status}`);
      }
      toast.success(`restart queued for "${processName}"`);
      setRestartConfirmOpen(false);
      setRestartTarget(null);
    } catch (error: unknown) {
      console.error('confirmRestartProcess error:', error);
      const msg = error instanceof Error ? error.message : 'failed to restart process';
      toast.error(msg);
    } finally {
      setRestartInFlight(false);
    }
  };

  const handleSetLaunchMode = async (machineId: string, processId: string, processName: string, mode: 'off' | 'always' | 'scheduled', exePath: string, schedules?: ScheduleBlock[] | null, schedulePresetId?: string | null, successMessage?: string) => {
    if (mode !== 'off' && (!exePath || exePath.trim() === '')) {
      toast.error(`cannot enable launch mode for "${processName}": executable path is not set. please edit the process and set a valid executable path.`);
      return;
    }

    try {
      // Scheduled mode with no schedules falls back to M-F 9-5.
      const effectiveSchedules = mode === 'scheduled' && (!schedules || schedules.length === 0)
        ? DEFAULT_SCHEDULE
        : schedules;
      await setLaunchMode(machineId, processId, processName, mode, effectiveSchedules, schedulePresetId);
      const modeLabels = { off: 'off', always: 'always on', scheduled: 'scheduled' };
      toast.success(successMessage ?? `launch mode set to ${modeLabels[mode]} for "${processName}"`);
    } catch (error: unknown) {
      console.error('handleSetLaunchMode error:', error);
      const msg = error instanceof Error ? error.message : 'Failed to set launch mode';
      toast.error(msg);
    }
  };

  const openEditProcessDialog = (machineId: string, process: Process) => {
    setProcessDialogMode('edit');
    setEditingMachineId(machineId);
    setEditingProcessId(process.id);

    // Legacy visibility values map onto the current options.
    let visibilityValue = process.visibility || 'Normal';
    if (visibilityValue === 'Show') {
      visibilityValue = 'Normal';
    } else if (visibilityValue === 'Hide') {
      visibilityValue = 'Hidden';
    }

    setEditProcessForm({
      name: process.name || '',
      exe_path: process.exe_path || '',
      file_path: process.file_path || '',
      cwd: process.cwd || '',
      priority: process.priority || 'Normal',
      visibility: visibilityValue,
      time_delay: process.time_delay || '0',
      time_to_init: process.time_to_init || '10',
      // 0 means unlimited relaunches; `|| '3'` would show a 3 the operator never set and
      // write it back on the next edit.
      relaunch_attempts:
        process.relaunch_attempts === undefined ||
        process.relaunch_attempts === null ||
        process.relaunch_attempts === ''
          ? '3'
          : String(process.relaunch_attempts),
      autolaunch: process.autolaunch || false,
      launch_mode: process.launch_mode || (process.autolaunch ? 'always' : 'off'),
      schedules: process.schedules || null,
    });
    setScheduleSectionOpen(false);
    setProcessDialogOpen(true);
  };

  const openCreateProcessDialog = (machineId: string) => {
    setProcessDialogMode('create');
    setEditingMachineId(machineId);
    setEditingProcessId(''); // No process ID for new process
    setEditProcessForm({
      name: '',
      exe_path: '',
      file_path: '',
      cwd: '',
      priority: 'Normal',
      visibility: 'Normal',
      time_delay: '0',
      time_to_init: '10',
      relaunch_attempts: '3',
      autolaunch: false,
      launch_mode: 'off' as LaunchMode,
      schedules: null as ScheduleBlock[] | null,
    });
    setScheduleSectionOpen(false);
    setProcessDialogOpen(true);
  };

  const handleUseSuggestedExePath = (alert: ExeMissingToastAlert, suggestedPath: string) => {
    const machine = machines.find((m) => m.machineId === alert.machineId);
    const process = machine?.processes?.find(
      (p) => p.id === alert.processId || p.name === alert.processName,
    );

    if (!machine || !process) {
      void navigator.clipboard?.writeText(suggestedPath);
      toast.success('suggested path copied');
      return;
    }

    openEditProcessDialog(alert.machineId, {
      ...process,
      exe_path: suggestedPath,
    });
  };

  useAgentAlertToasts(currentSiteId, handleUseSuggestedExePath);

  const handleSaveProcess = async () => {
    if (!editProcessForm.name || !editProcessForm.name.trim()) {
      toast.error('process name is required');
      return;
    }

    if (!editProcessForm.exe_path || !editProcessForm.exe_path.trim()) {
      toast.error('executable path is required');
      return;
    }

    try {
      if (processDialogMode === 'create') {
        await createProcess(editingMachineId, editProcessForm);
        toast.success(`Process "${editProcessForm.name}" created successfully!`);
      } else {
        await updateProcess(editingMachineId, editingProcessId, editProcessForm);
        toast.success(`Process "${editProcessForm.name}" updated successfully!`);
      }
      setProcessDialogOpen(false);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : `Failed to ${processDialogMode} process`;
      toast.error(msg);
    }
  };

  const handleDuplicateProcess = async (machineId: string, process: Process) => {
    // Suffix the name to clear the server's per-machine unique-name check; launch_mode
    // 'off' so the copy never auto-launches a second instance of the same exe.
    const machine = machines.find((m) => m.machineId === machineId);
    const existingNames = machine?.processes?.map((p) => p.name) ?? [];
    const newName = nextDuplicateName(process.name, existingNames);

    try {
      await createProcess(machineId, {
        name: newName,
        exe_path: process.exe_path,
        file_path: process.file_path,
        cwd: process.cwd,
        priority: process.priority,
        visibility: process.visibility,
        time_delay: process.time_delay,
        time_to_init: process.time_to_init,
        relaunch_attempts: process.relaunch_attempts,
        launch_mode: 'off',
        schedules: process.schedules ?? null,
      });
      toast.success(`duplicated "${process.name}" as "${newName}"`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to duplicate process';
      toast.error(msg);
    }
  };

  const handleDeleteProcess = async () => {
    try {
      await deleteProcess(editingMachineId, editingProcessId);
      toast.success(`Process "${editProcessForm.name}" deleted successfully!`);
      setProcessDialogOpen(false);
      setDeleteConfirmOpen(false);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to delete process';
      toast.error(msg);
    }
  };

  const openRemoveMachineDialog = (machineId: string, machineName: string, isOnline: boolean) => {
    setMachineToRemove({ id: machineId, name: machineName, isOnline });
    setRemoveMachineDialogOpen(true);
  };

  const handleConfirmRemoveMachine = async () => {
    if (!machineToRemove) return;

    try {
      await removeMachineFromSite(machineToRemove.id);
      toast.success(`Machine "${machineToRemove.name}" removed from site successfully!`);
      setRemoveMachineDialogOpen(false);
      setMachineToRemove(null);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to remove machine';
      toast.error(msg);
    }
  };

  // useLayoutEffect, not useEffect: it runs before paint, so returning users never see
  // the default 'card' view flash before 'list' is restored.
  useLayoutEffect(() => {
    const savedView = localStorage.getItem('owlette_view_type');
    if (savedView === 'card' || savedView === 'list') {
      setViewType(savedView);
    }
  }, []);

  const handleViewChange = (view: ViewType) => {
    setViewType(view);
    localStorage.setItem('owlette_view_type', view);
  };

  // Saved site from Firestore (cross-browser) or localStorage (same-browser fallback).
  // setState-in-effect is deliberate: `sites` + `lastSiteId` load async, so a lazy
  // initializer can't see them at mount.
  //
  // This picks ONCE, so it is only as good as the list it first sees settle. That
  // is safe because `useSites` can't settle before access has resolved — user doc
  // (so `lastSiteId`) and memberships both in — nor on a partial per-site list.
  // Before that, a reload could latch `sites[0]` of a half-read list instead of
  // the last viewed site.
  useEffect(() => {
    if (!sitesLoading && sites.length > 0 && !currentSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setCurrentSiteId(savedSite);
      } else {
        setCurrentSiteId(sites[0].id);
      }
    }
  }, [sites, sitesLoading, currentSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    updateLastSite(siteId);
  };

  // DO NOT SIMPLIFY — every attempt has reintroduced the "step 1: create your first site"
  // flicker on reload. useMachines('') sets machinesLoading=false immediately when there is
  // no currentSiteId, so `!machinesLoading` alone is true on the very first render; the
  // `!sitesLoading` gate is what suppresses the one-paint flash.
  // Show the card only for: (a) no sites at all, or (b) a selected site whose machines have
  // finished loading and is empty. Everything else renders null.
  const showGettingStarted = useMemo(() => {
    if (sitesLoading) return false;
    if (sites.length === 0) return true;
    // Have sites; need a selected one whose machines have finished loading.
    return !!currentSiteId && !machinesLoading && machines.length === 0;
  }, [sitesLoading, sites.length, currentSiteId, machinesLoading, machines.length]);

  // id + online only, memoized so the heavy panel doesn't re-render on every dashboard paint.
  const switcherMachines = useMemo(
    () => machines.map((m) => ({ machineId: m.machineId, online: m.online })),
    [machines],
  );

  // Its own window, never an iframe or a dialog: the stage grabs the keyboard and
  // pointer, and a session must survive navigating the dashboard. No token in the
  // URL — the page authorizes itself against the session-create route.
  const openSwoop = (machineId: string) => {
    window.open(
      `/swoop/${encodeURIComponent(currentSiteId)}/${encodeURIComponent(machineId)}`,
      '_blank',
      'noopener',
    );
  };

  // A click SWAPS the panel selection (overwrites this machine's graphTabs) rather than
  // merging, so clicking cells behaves like switching tabs, not accumulating them.
  const handleMetricClick = (machineId: string, metric: MetricType) => {
    // 'display' is a panel route, not a chart tab — writing it would persist entries
    // deserializeTabs drops on read.
    if (metric === 'display') {
      updateUserPreferences(
        { activeGraphPanel: { machineId, metric } },
        { silent: true },
      ).catch(() => { /* fire-and-forget, matches graphTabs pattern */ });
      return;
    }

    // A generic 'disk'/'gpu' (or NIC util) click expands to every per-device id on the
    // machine, not just the device that happened to be in the clicked cell.
    const clickIds = serializeTabs(initialMetricToState(metric));
    const machine = machines.find((m) => m.machineId === machineId);
    if (machine?.devices) {
      if (metric === 'disk') {
        for (const d of machine.devices.disks) clickIds.push(`disk:${d.id}`);
      } else if (metric === 'gpu') {
        for (const g of machine.devices.gpus) clickIds.push(`gpu:${g.id}`);
      } else if (metric.endsWith('_tx_util') || metric.endsWith('_rx_util')) {
        // initialMetricToState already seeded the clicked NIC — dedupe.
        const seen = new Set(clickIds);
        for (const n of machine.devices.nics) {
          const id = `nic:${n.id}`;
          if (!seen.has(id)) clickIds.push(id);
        }
      }
    }

    updateUserPreferences(
      {
        activeGraphPanel: { machineId, metric },
        graphTabs: { ...(userPreferences.graphTabs || {}), [machineId]: clickIds },
      },
      { silent: true },
    ).catch(() => { /* fire-and-forget, matches graphTabs pattern */ });
  };

  // Switch machines, keeping the metric (re-expanded for the new devices).
  const handleSwitchMachine = (machineId: string) => {
    if (!heldDetailPanel || heldDetailPanel.metric === 'display') return;
    handleMetricClick(machineId, heldDetailPanel.metric);
  };

  const handleCloseDetailPanel = () => {
    updateUserPreferences(
      { activeGraphPanel: null },
      { silent: true },
    ).catch(() => { /* fire-and-forget */ });
  };

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  // Redirect users who still owe 2FA setup.
  useEffect(() => {
    if (!loading && user && requiresMfaSetup) {
      router.push('/setup-2fa');
    }
  }, [loading, user, requiresMfaSetup, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <FallingFeather />
        <p className="text-muted-foreground"><LoadingWord /></p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const onlineMachines = machines.filter(m => m.online).length;
  const totalProcesses = machines.reduce((acc, m) => {
    return acc + (m.metrics?.processes ? Object.keys(m.metrics.processes).length : 0);
  }, 0);

  const currentSite = sites.find(s => s.id === currentSiteId);

  return (
    <div className="relative min-h-screen pb-24 animate-in fade-in duration-300">
      {/* Header */}
      <PageHeader
        currentPage="dashboard"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      {/* Site Management Dialogs */}
      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        machineCount={machines.length}
        currentUserId={user?.uid}
        isSuperadmin={isSuperadmin}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          // Deleting the current site: switch to another, or clear the selection
          // when that was the last one. Without the else, currentSiteId keeps
          // pointing at a site that no longer exists and every child query runs
          // against a dead id — reachable now that deleting your last site is
          // allowed (the browser-only guard was removed, see
          // dev/active/per-site-roles/).
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            } else {
              setCurrentSiteId('');
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        onSiteCreated={(siteId) => setCurrentSiteId(siteId)}
      />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1 truncate">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      {randomWelcome.text.toLowerCase()}{user.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}!
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-semibold">{randomWelcome.language}</p>
                    <p className="text-xs text-foreground">{randomWelcome.translation}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </h2>
            <p className="text-sm md:text-base text-muted-foreground">
              {randomJoke.toLowerCase()}
            </p>
          </div>

          {/* Quick stats - inline with welcome. Wraps at narrow widths so the
              two stat blocks + divider can never push the page wider than the
              viewport. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6 md:gap-8">
            {/* Machines / Online ratio */}
            <div className="flex items-center gap-2.5">
              <div className={`rounded-md p-1.5 ${onlineMachines > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                <Monitor className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-baseline gap-0.5 tabular-nums">
                  <span className={`text-xl font-bold ${onlineMachines > 0 ? 'text-emerald-400' : 'text-foreground'}`}>{onlineMachines}</span>
                  <span className="text-xs text-muted-foreground">/ {machines.length}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">online</p>
              </div>
            </div>

            {/* Divider */}
            <div className="h-8 w-px bg-border" />

            {/* Processes */}
            <div className="flex items-center gap-2.5">
              <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                <Cog className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-baseline gap-0.5 tabular-nums">
                  <span className="text-xl font-bold text-foreground">{totalProcesses}</span>
                  <span className="text-xs text-muted-foreground">managed</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">processes</p>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Detail Panel — animates pixel `height` from 0 →
            measured px on open and back to 0 on close. Wrapper height
            is controlled imperatively by `useSlidePanel`; children
            mount synchronously on open so the height transition has
            fully-laid-out content to interpolate over. That trades a
            small click-to-slide delay (mount cost) for a smooth slide
            animation with no per-frame layout cost. */}
        <div
          ref={slideWrapperRef}
          className="overflow-hidden transition-[height] duration-200 ease-out"
          style={{ contain: 'layout paint' }}
          aria-hidden={!detailPanel}
        >
          {/* Inner container: scrollHeight on this element measures the
              natural content size (the wrapper's scrollHeight is clipped by
              its own `height: 0`). `pb-6` (padding, not margin) absorbs the
              old wrapper margin toggle into the measured height — so the
              24px below-panel gap transitions alongside the panel itself
              rather than snapping in/out at either end. */}
          <div ref={slideContentRef} className="pb-6" style={{ contain: 'layout paint' }}>
            {heldDetailPanel && (
              heldDetailPanel.metric === 'display' ? (
                <DisplayLayoutPanel
                  machineId={heldDetailPanel.machineId}
                  machineName={heldDetailPanel.machineName}
                  siteId={currentSiteId}
                  capabilities={machines.find((m) => m.machineId === heldDetailPanel.machineId)?.capabilities}
                  onClose={handleCloseDetailPanel}
                />
              ) : (
                <MetricsDetailPanel
                  machineId={heldDetailPanel.machineId}
                  machineName={heldDetailPanel.machineName}
                  siteId={currentSiteId}
                  initialMetric={heldDetailPanel.metric}
                  onClose={handleCloseDetailPanel}
                  gpus={machines.find((m) => m.machineId === heldDetailPanel.machineId)?.devices?.gpus}
                  machines={switcherMachines}
                  onSwitchMachine={handleSwitchMachine}
                />
              )
            )}
          </div>
        </div>

        {/* Machines list — during the detail panel's slide animation we
            mark this subtree so the global rule in globals.css can apply
            `content-visibility: auto` + `contain-intrinsic-size` to each
            row/card. Offscreen rows skip layout/paint while the wrapper
            transitions, keeping the slide's frame budget clear. Flag lifts
            as soon as bodyReady commits (or, on close, once the held panel
            unmounts), so normal interaction is unaffected. */}
        {machines.length > 0 ? (
          <div className="space-y-6" data-slide-pausing={slideAnimating ? 'true' : undefined}>
            {/* Renders null — no wrapper, no spacer — on every site that has
                already answered, has no scheduled processes, or whose viewer
                isn't a site admin. `space-y-6` keys off real children, so a null
                render leaves the machines heading exactly where it was. */}
            <SiteTimeConfirmBanner
              siteId={currentSiteId}
              siteTimezone={currentSite?.timezone}
              // Firestore snapshot, not GET /api/sites/{siteId}: the REST
              // representation collapses absent into false, which would make
              // this banner unreachable.
              schedulesFollowSiteTime={currentSite?.schedulesFollowSiteTime}
              machines={machines}
              isSiteAdmin={isSiteAdmin(currentSiteId)}
              onUpdateSite={updateSite}
            />

            {/* Heading + controls. `flex-wrap` lets the add-machine button and
                the segmented view toggle drop under the heading at narrow
                widths instead of squeezing the row past the viewport. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg md:text-xl font-bold text-foreground">machines</h3>

              <div className="flex items-center gap-2">
                {/* Add Machine Button */}
                <AddMachineButton
                  currentSiteId={currentSiteId}
                  currentSiteName={currentSite?.name}
                />

                {/* Expand/Collapse All + View Toggle */}
                <div className="flex items-center gap-1 rounded-lg bg-card-sunken p-1 select-none">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleAllExpanded}
                        className="cursor-pointer text-muted-foreground"
                      >
                        {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{allExpanded ? 'collapse all' : 'expand all'}</p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="h-4 w-px bg-border" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewChange('card')}
                        className={`cursor-pointer ${viewType === 'card' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
                      >
                        <LayoutGrid className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>card view</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewChange('list')}
                        data-testid="view-toggle-list"
                        className={`cursor-pointer ${viewType === 'list' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
                      >
                        <List className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>list view</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Card View — only rendered when active */}
            {viewType === 'card' && (
              <div className="animate-in fade-in duration-300">
                <MachineCardView
                  machines={machines}
                  statsExpanded={userPreferences.statsExpanded}
                  processesExpanded={userPreferences.processesExpanded}
                  displaysExpanded={userPreferences.displaysExpanded ?? false}
                  onToggleStats={toggleStatsExpanded}
                  onToggleProcesses={toggleProcessesExpanded}
                  onToggleDisplays={toggleDisplaysExpanded}
                  currentSiteId={currentSiteId}
                  siteTimezone={currentSite?.timezone}
                  siteTimeFormat={userPreferences.timeFormat || '12h'}
                  onEditProcess={openEditProcessDialog}
                  onDuplicateProcess={handleDuplicateProcess}
                  onCreateProcess={openCreateProcessDialog}
                  onKillProcess={handleKillProcess}
                  onRestartProcess={handleRestartProcess}
                  onSetLaunchMode={handleSetLaunchMode}
                  onConfigureSchedule={handleConfigureSchedule}
                  onRemoveMachine={openRemoveMachineDialog}
                  onMetricClick={handleMetricClick}
                  onRestart={restartMachine}
                  onShutdown={shutdownMachine}
                  onCancelRestart={cancelRestart}
                  onDismissRestartPending={dismissRestartPending}
                  onScreenshot={(machineId) => {
                    const m = machines.find(m => m.machineId === machineId);
                    setScreenshotTarget({ machineId, machineName: machineId, isOnline: m?.online ?? false });
                    setScreenshotDialogOpen(true);
                  }}
                  onLiveView={(machineId) => {
                    setLiveViewTarget({ machineId, machineName: machineId });
                    setLiveViewOpen(true);
                  }}
                  onSwoop={openSwoop}
                />
              </div>
            )}

            {/* List View — only rendered when active */}
            {viewType === 'list' && (
              /* overflow-x-auto (not hidden) gives the fixed-layout table's own scroller
                 somewhere to go instead of clipping; overflow-y-hidden keeps the rounded
                 corners clipping the first/last rows. */
              <div className="rounded-xl border border-border/60 bg-card-sunken overflow-x-auto overflow-y-hidden animate-in fade-in duration-300">
                <Table style={{ contain: 'layout', tableLayout: 'fixed' }}>
                  <MachineTableHeader
                    deviceUnion={deviceUnion}
                    showDropdown={showDropdown}
                    listPref={listPref}
                    setListPref={setListPref}
                  />
                  <TableBody>
                    {machines.map((machine) => (
                      <MachineRow
                        key={machine.machineId}
                        machine={machine}
                        schedulesFollowSiteTime={currentSite?.schedulesFollowSiteTime}
                        listPref={listPref}
                        isExpanded={expandedMachineIds.has(machine.machineId)}
                        currentSiteId={currentSiteId}
                        siteTimezone={currentSite?.timezone || 'UTC'}
                        siteTimeFormat={userPreferences.timeFormat || '12h'}
                        userPreferences={userPreferences}
                        isSiteAdmin={isSiteAdmin(currentSiteId)}
                        onToggleExpanded={() => toggleMachineExpanded(machine.machineId)}
                        onEditProcess={(process) => openEditProcessDialog(machine.machineId, process)}
                        onDuplicateProcess={(process) => handleDuplicateProcess(machine.machineId, process)}
                        onCreateProcess={() => openCreateProcessDialog(machine.machineId)}
                        onKillProcess={(processId, processName) => handleKillProcess(machine.machineId, processId, processName)}
                        onRestartProcess={(processId, processName) => handleRestartProcess(machine.machineId, processId, processName)}
                        onSetLaunchMode={(processId, processName, mode, exePath, schedules) =>
                          handleSetLaunchMode(machine.machineId, processId, processName, mode, exePath, schedules)
                        }
                        onConfigureSchedule={(process) => handleConfigureSchedule(machine.machineId, process)}
                        onRemoveMachine={() => openRemoveMachineDialog(machine.machineId, machine.machineId, machine.online)}
                        onMetricClick={(metricType) => handleMetricClick(machine.machineId, metricType)}
                        onRestart={() => restartMachine(machine.machineId)}
                        onShutdown={() => shutdownMachine(machine.machineId)}
                        onCancelRestart={() => cancelRestart(machine.machineId)}
                        onScreenshot={() => {
                          setScreenshotTarget({ machineId: machine.machineId, machineName: machine.machineId, isOnline: machine.online });
                          setScreenshotDialogOpen(true);
                        }}
                        onLiveView={() => {
                          setLiveViewTarget({ machineId: machine.machineId, machineName: machine.machineId });
                          setLiveViewOpen(true);
                        }}
                        onSwoop={() => openSwoop(machine.machineId)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        ) : showGettingStarted ? (
          <Card className="border-border bg-card animate-in fade-in duration-300">
            <CardHeader>
              <CardTitle className="text-foreground">getting started</CardTitle>
              <CardDescription className="text-muted-foreground">
                connect your first machine to start managing processes
              </CardDescription>
              {/* Header "+" — reachable even with zero machines, so the manual
"enter code" and bulk "generate code" pairing paths aren't
                  gated behind already having a machine. */}
              {sites.length > 0 && (
                <CardAction>
                  <AddMachineButton
                    currentSiteId={currentSiteId}
                    currentSiteName={currentSite?.name}
                    open={addMachineOpen}
                    onOpenChange={setAddMachineOpen}
                    tab={addMachineTab}
                    onTabChange={setAddMachineTab}
                  />
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Step 1: Create Your First Site (only shown when no sites exist) */}
              {sites.length === 0 && (
                <div className="rounded-lg border border-accent-cyan/40 bg-accent-cyan/5 p-6">
                  <h3 className="text-lg font-bold text-foreground mb-2">step 1: create your first site</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Sites organize your machines by location or purpose (e.g., &quot;NYC Office&quot;, &quot;Home Studio&quot;, &quot;Production Floor&quot;).
                    Create your first site to get started!
                  </p>
                  <Button
                    onClick={() => setCreateDialogOpen(true)}
                    className="text-gray-900 font-semibold px-6 py-3 cursor-pointer"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    create your first site
                  </Button>
                </div>
              )}

              {/* Steps 2-5: Only shown after site is created */}
              {sites.length > 0 && (
                <>
                  <div className="rounded-lg border border-border bg-card-sunken p-4">
                    <h3 className="font-semibold text-foreground mb-3">step 1: download owlette agent</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  download and run the installer <strong className="text-foreground">on the machine you want to add</strong> (not necessarily this one).
                  use the copy link option if connecting via remote desktop tools like Parsec, TeamViewer, or RDP.
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      if (!downloadUrl) {
                        toast.error('download unavailable', {
                          description: 'installer download URL is not available.',
                        });
                        return;
                      }
                      try {
                        window.open(downloadUrl, '_blank');
                        toast.success('download started', {
                          description: `downloading owlette v${version}`,
                        });
                      } catch {
                        toast.error('download failed', {
                          description: 'failed to start download. please try again.',
                        });
                      }
                    }}
                    disabled={!downloadUrl}
                    className="flex-1 text-gray-900 cursor-pointer"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    <span>download {version && `v${version}`}</span>
                  </Button>
                  <Button
                    onClick={() => {
                      if (!downloadUrl) {
                        toast.error('copy failed', {
                          description: 'download URL is not available.',
                        });
                        return;
                      }
                      try {
                        navigator.clipboard.writeText(downloadUrl);
                        toast.success('link copied', {
                          description: 'download link copied to clipboard',
                        });
                      } catch {
                        toast.error('copy failed', {
                          description: 'failed to copy link. please try again.',
                        });
                      }
                    }}
                    disabled={!downloadUrl}
                    className="flex-1 text-gray-900 cursor-pointer"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    <span>copy link</span>
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card-sunken p-4">
                <h3 className="font-semibold text-foreground">step 2: run the installer</h3>
                <p className="text-sm text-muted-foreground">
                  on that machine, double-click the installer - press Enter only if you want to open the pairing page locally
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card-sunken p-4">
                <h3 className="font-semibold text-foreground">step 3: authorize agent</h3>
                <p className="text-sm text-muted-foreground">
                  log in and authorize the agent for site <span className="font-mono text-accent-cyan">{currentSite?.name || currentSiteId}</span>
                </p>

                {emptyStateAuthorize.success ? (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-foreground">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    machine authorized — it will appear above within seconds.
                  </div>
                ) : (
                  <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                    <p className="text-sm text-muted-foreground">
                      on remote desktop (Parsec, TeamViewer, RDP)? enter the 3-word phrase the installer shows instead:
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={emptyStateAuthorize.phrase}
                        onChange={(e) => emptyStateAuthorize.setPhrase(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') emptyStateAuthorize.authorize(); }}
                        placeholder="e.g., silver-compass-drift"
                        className="border-border bg-muted/50 font-mono text-foreground"
                        autoComplete="off"
                        data-testid="getting-started-enter-phrase"
                      />
                      <Button
                        onClick={() => emptyStateAuthorize.authorize()}
                        disabled={!emptyStateAuthorize.phrase.trim() || emptyStateAuthorize.isAuthorizing}
                        className="shrink-0 text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="getting-started-authorize"
                      >
                        {emptyStateAuthorize.isAuthorizing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            authorizing...
                          </>
                        ) : (
                          'authorize'
                        )}
                      </Button>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setAddMachineTab('generate'); setAddMachineOpen(true); }}
                      className="hl-link hl-link-muted text-xs text-muted-foreground cursor-pointer"
                    >
                      deploying many machines at once? generate a silent-install code
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border bg-card-sunken p-4">
                <h3 className="font-semibold text-foreground">step 4: done!</h3>
                <p className="text-sm text-muted-foreground">
                  the installer completes automatically and that machine will appear above within seconds
                </p>
              </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : null}
      </main>

      {/* Process Dialog (Create/Edit) */}
      <Dialog open={processDialogOpen} onOpenChange={setProcessDialogOpen}>
        <DialogContent className="border-border bg-muted text-foreground sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {processDialogMode === 'create' ? 'add process' : 'edit process'}

            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {processDialogMode === 'create'
                ? 'add a process to this machine'
                : 'update process configuration'}
            </DialogDescription>
          </DialogHeader>
          {/* The form scrolls inside the dialog: with the schedule section open
              the fields alone can outgrow a laptop viewport, and a Dialog that
              overflows puts its footer (save/cancel) out of reach. */}
          <div ref={processFormRef} className="space-y-4 py-4 max-h-[70vh] overflow-y-auto pr-1">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="text-foreground">name</Label>
              <Input
                id="edit-name"
                value={editProcessForm.name}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, name: e.target.value })}
                className="border-border bg-card text-foreground"
              />
            </div>

            {/* Launch Mode — positioned prominently after name */}
            <div className="space-y-2">
              <Label className="text-foreground text-sm">launch mode</Label>
              <div className="flex items-stretch rounded-lg overflow-hidden border border-border">
                {(['off', 'always', 'scheduled'] as const).map((mode) => {
                  const labels = { off: 'off', always: 'always on', scheduled: 'scheduled' };
                  const isActive = editProcessForm.launch_mode === mode;
                  const colors = {
                    off: isActive ? 'bg-muted text-foreground' : '',
                    always: isActive ? 'bg-emerald-600 text-white' : '',
                    scheduled: isActive ? 'bg-blue-600 text-white' : '',
                  };

                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setEditProcessForm({ ...editProcessForm, launch_mode: mode, autolaunch: mode !== 'off' })}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${colors[mode]} ${!isActive ? 'bg-card text-muted-foreground hover:bg-muted/50' : ''}`}
                    >
                      {labels[mode]}
                    </button>
                  );
                })}
                {/* Schedule disclosure — the machine rows' gear affordance: flush
                    at the end of the segmented control, one hairline between. It
                    is offered in EVERY mode (the schedule is always editable);
                    in `scheduled` the section below is pinned open, so the gear
                    reads as the marker for a section that is already showing.
                    It never selects a mode — only the segments do that. */}
                <span className={`w-px ${editProcessForm.launch_mode === 'scheduled' ? 'bg-blue-400/50' : 'bg-border'}`} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="configure schedule"
                      aria-expanded={scheduleSectionVisible}
                      data-testid="process-dialog-configure-schedule"
                      onClick={() => setScheduleSectionOpen((open) => !open)}
                      className={`px-2 transition-colors cursor-pointer flex items-center ${editProcessForm.launch_mode === 'scheduled' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-card text-muted-foreground hover:bg-muted/50'}`}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>configure schedule</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Executable Path */}
            <div className="space-y-2">
              <Label htmlFor="edit-exe-path" className="text-foreground">executable path</Label>
              <Input
                id="edit-exe-path"
                value={editProcessForm.exe_path}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, exe_path: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="C:/Program Files/..."
              />
            </div>

            {/* File Path / Cmd Args */}
            <div className="space-y-2">
              <Label htmlFor="edit-file-path" className="text-foreground">file path / command arguments</Label>
              <Input
                id="edit-file-path"
                value={editProcessForm.file_path}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, file_path: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="optional"
              />
            </div>

            {/* Working Directory */}
            <div className="space-y-2">
              <Label htmlFor="edit-cwd" className="text-foreground">working directory</Label>
              <Input
                id="edit-cwd"
                value={editProcessForm.cwd}
                onChange={(e) => setEditProcessForm({ ...editProcessForm, cwd: e.target.value })}
                className="border-border bg-card text-foreground"
                placeholder="optional"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Priority */}
              <div className="space-y-2">
                <Label htmlFor="edit-priority" className="text-foreground">task priority</Label>

                <Select
                  value={editProcessForm.priority}
                  onValueChange={(value) => setEditProcessForm({ ...editProcessForm, priority: value })}
                >
                  <SelectTrigger id="edit-priority" className="border-border bg-card text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    <SelectItem value="Low">low</SelectItem>
                    <SelectItem value="Normal">normal</SelectItem>
                    <SelectItem value="High">high</SelectItem>
                    <SelectItem value="Realtime">realtime</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Visibility */}
              <div className="space-y-2">
                <Label htmlFor="edit-visibility" className="text-foreground">window visibility</Label>
                <Select
                  value={editProcessForm.visibility}
                  onValueChange={(value) => setEditProcessForm({ ...editProcessForm, visibility: value })}
                >
                  <SelectTrigger id="edit-visibility" className="border-border bg-card text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    <SelectItem value="Normal">normal</SelectItem>
                    <SelectItem value="Hidden">hidden (console apps only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Empty space for alignment */}
              <div></div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Time Delay */}
              <div className="space-y-2">
                <Label htmlFor="edit-time-delay" className="text-foreground">launch delay (sec)</Label>
                <Input
                  id="edit-time-delay"
                  type="number"
                  value={editProcessForm.time_delay}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, time_delay: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>

              {/* Time to Init */}
              <div className="space-y-2">
                <Label htmlFor="edit-time-init" className="text-foreground">init timeout (sec)</Label>
                <Input
                  id="edit-time-init"
                  type="number"
                  value={editProcessForm.time_to_init}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, time_to_init: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>

              {/* Relaunch Attempts */}
              <div className="space-y-2">
                <Label htmlFor="edit-relaunch" className="text-foreground">relaunch attempts</Label>
                <Input
                  id="edit-relaunch"
                  type="number"
                  value={editProcessForm.relaunch_attempts}
                  onChange={(e) => setEditProcessForm({ ...editProcessForm, relaunch_attempts: e.target.value })}
                  className="border-border bg-card text-foreground"
                />
              </div>
            </div>

            {/* Schedule Configuration — auto-shown in `scheduled` mode, disclosed
                by the gear in `off` / `always on`. Edits here are saved with the
                rest of the form and never move the launch mode. */}
            {scheduleSectionVisible && (
              <div className="space-y-3 rounded-lg border border-blue-600/30 bg-blue-500/5 p-3" data-testid="process-dialog-schedule-section">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 text-blue-400" />
                    <span className="text-xs font-medium text-blue-400">schedule configuration</span>
                  </div>
                  {/* `scheduleClockLabel` is the single source for this string — the
                      clock only belongs to the site once it has opted in. (This used
                      to say "kept in sync with ProcessDialog.tsx by convention";
                      that component was unused and was deleted 2026-09-08.) */}
                  <span className="text-[10px] text-muted-foreground">
                    {scheduleClockLabel(currentSite?.timezone, currentSite?.schedulesFollowSiteTime)}
                  </span>
                </div>
                {editProcessForm.launch_mode !== 'scheduled' && (
                  <p className="text-[11px] text-muted-foreground">
                    saved with the process — switch to scheduled whenever you want these windows to run it
                  </p>
                )}
                <div className="flex justify-center mb-2">
                  <WeekSummaryBar schedules={scheduleBlocks} tall />
                </div>
                <div className="max-h-[200px] overflow-y-auto pr-1">
                  <ScheduleBlocksEditor
                    blocks={scheduleBlocks}
                    onChange={(blocks) => setEditProcessForm({ ...editProcessForm, schedules: blocks })}
                    compact
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="flex items-center">
            {processDialogMode === 'edit' && (
              <Button
                variant="ghost"
                onClick={() => setDeleteConfirmOpen(true)}
                className="text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button
                variant="ghost"
                onClick={() => setProcessDialogOpen(false)}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                onClick={handleSaveProcess}
                className="text-gray-900 cursor-pointer"
              >
                {processDialogMode === 'create' ? 'create process' : 'save changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Process Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="border-border bg-muted text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">delete process</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to permanently delete &quot;{editProcessForm.name}&quot;? this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteConfirmOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleDeleteProcess}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              delete process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Account Settings Dialog */}
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />

      {/* Remove Machine Dialog */}
      {machineToRemove && (
        <RemoveMachineDialog
          open={removeMachineDialogOpen}
          onOpenChange={setRemoveMachineDialogOpen}
          machineId={machineToRemove.id}
          machineName={machineToRemove.name}
          isOnline={machineToRemove.isOnline}
          hasActiveDeployments={checkMachineHasActiveDeployment(machineToRemove.id)}
          isRemoving={isRemovingMachine}
          onConfirmRemove={handleConfirmRemoveMachine}
        />
      )}

      {/* Kill Process Confirmation Dialog */}
      <Dialog open={killConfirmOpen} onOpenChange={setKillConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>kill process</DialogTitle>
            <DialogDescription>
              are you sure you want to kill <span className="font-semibold text-foreground">{killTarget?.processName}</span>? this will immediately terminate the process.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setKillConfirmOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmKillProcess}
            >
              <Square className="h-4 w-4 mr-2" />
              kill process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restart Process Confirmation Dialog */}
      <Dialog
        open={restartConfirmOpen}
        onOpenChange={(open) => {
          if (restartInFlight) return;
          setRestartConfirmOpen(open);
          if (!open) setRestartTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>restart {restartTarget?.processName}?</DialogTitle>
            <DialogDescription>
              restart <span className="font-semibold text-foreground">{restartTarget?.processName}</span> on <span className="font-semibold text-foreground">{restartTarget?.machineId}</span>? this will briefly stop the process before relaunching.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRestartConfirmOpen(false);
                setRestartTarget(null);
              }}
              disabled={restartInFlight}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="default"
              onClick={confirmRestartProcess}
              disabled={restartInFlight}
            >
              <RotateCw className={`h-4 w-4 mr-2 ${restartInFlight ? 'animate-spin' : ''}`} />
              restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule Editor Dialog — only mounted when open for fresh state each time */}
      {scheduleEditorOpen && scheduleEditorTarget && (
        <ScheduleEditor
          open
          onOpenChange={(open) => {
            setScheduleEditorOpen(open);
            if (!open) setScheduleEditorTarget(null);
          }}
          schedules={scheduleEditorTarget.process._optimisticSchedules ?? scheduleEditorTarget.process.schedules ?? null}
          initialPresetId={scheduleEditorTarget.process._optimisticPresetId ?? scheduleEditorTarget.process.schedulePresetId}
          onChange={handleScheduleApply}
          siteTimezone={currentSite?.timezone}
          // Firestore snapshot, deliberately: the REST API collapses absent and
          // false into one `=== true`, and the dialog needs all three states.
          schedulesFollowSiteTime={currentSite?.schedulesFollowSiteTime}
          targetMachineAgentVersion={machines.find(m => m.machineId === scheduleEditorTarget.machineId)?.agent_version}
          currentLaunchMode={(scheduleEditorTarget.process._optimisticLaunchMode ?? scheduleEditorTarget.process.launch_mode ?? (scheduleEditorTarget.process.autolaunch ? 'always' : 'off')) as 'off' | 'always' | 'scheduled'}
          presets={schedulePresets}
          onCreatePreset={handleCreatePreset}
          onDeletePreset={async (id) => { await deleteSchedulePreset(id); toast.success('Preset deleted'); }}
          onUpdatePreset={async (id, updates) => { await updateSchedulePreset(id, updates); toast.success('Preset updated'); }}
        />
      )}

      {/* Screenshot Dialog */}
      {screenshotTarget && (
        <ScreenshotDialog
          open={screenshotDialogOpen}
          onOpenChange={setScreenshotDialogOpen}
          machineId={screenshotTarget.machineId}
          machineName={screenshotTarget.machineName}
          machineTimezone={machines.find(m => m.machineId === screenshotTarget.machineId)?.machineTimezone}
          siteId={currentSiteId}
          isOnline={screenshotTarget.isOnline}
          onCaptureScreenshot={() => captureScreenshot(screenshotTarget.machineId)}
          lastScreenshot={machines.find(m => m.machineId === screenshotTarget.machineId)?.lastScreenshot}
          hasActiveDeployment={checkMachineHasActiveDeployment(screenshotTarget.machineId)}
        />
      )}

      {/* Live View Modal */}
      {liveViewTarget && (
        <LiveViewModal
          open={liveViewOpen}
          onOpenChange={setLiveViewOpen}
          siteId={currentSiteId}
          machineId={liveViewTarget.machineId}
          machineName={liveViewTarget.machineName}
          onStartLiveView={startLiveView}
          onStopLiveView={stopLiveView}
        />
      )}
    </div>
  );
}
