/**
 * the words for a process's launch target, by the machine it runs on. the saved
 * field is `exe_path` everywhere, but it holds an .exe on windows, an .app
 * bundle on macos and a binary on linux, so only the copy changes. the desktop
 * app keeps its own table in desktop/src/lib/launchCopy.ts.
 */
import type { MachineOsFamily } from '@/lib/machineOs';

export interface LaunchCopy {
  /** the field's label; the editor's toasts name the field with it too */
  label: string;
  placeholder: string;
  /** the launch target itself, for the toast when an agent cannot find it */
  target: string;
}

const COPY: Record<MachineOsFamily, LaunchCopy> = {
  windows: { label: 'executable path', placeholder: 'C:\\Program Files\\...\\app.exe', target: 'executable' },
  macos: { label: 'app path', placeholder: '/Applications/YourApp.app', target: 'app' },
  linux: { label: 'program path', placeholder: '/usr/bin/your-program', target: 'program' },
};

/** an agent that reports no `osFamily` is a windows one */
export function launchCopy(osFamily: MachineOsFamily | undefined): LaunchCopy {
  return COPY[osFamily ?? 'windows'];
}
