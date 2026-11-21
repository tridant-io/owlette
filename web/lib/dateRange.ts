// the date range presets the logs and activity pages share, resolved in the viewer's own time zone
export type DatePreset = 'all' | 'last_hour' | 'last_24h' | 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_week' | 'this_month' | 'last_month' | 'custom';

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'all time' },
  { value: 'last_hour', label: 'last hour' },
  { value: 'last_24h', label: 'last 24 hours' },
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: 'last_7', label: 'last 7 days' },
  { value: 'last_30', label: 'last 30 days' },
  { value: 'this_week', label: 'this week' },
  { value: 'this_month', label: 'this month' },
  { value: 'last_month', label: 'last month' },
  { value: 'custom', label: 'custom range' },
];

export function getDateRange(preset: DatePreset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (preset) {
    case 'all':
      return { from: null, to: null };
    case 'last_hour': {
      const d = new Date(now);
      d.setHours(d.getHours() - 1);
      return { from: d, to: now };
    }
    case 'last_24h': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { from: d, to: now };
    }
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last_7': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'last_30': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      // Monday as start of week
      const diff = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diff);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from, to };
    }
    case 'custom': {
      const from = customFrom ? startOfDay(new Date(customFrom + 'T00:00:00')) : null;
      const to = customTo ? endOfDay(new Date(customTo + 'T00:00:00')) : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

// Bridge the native-string filter state (YYYY-MM-DD) <-> the DatePicker's Date value.
export const toYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromYMD = (s: string): Date | undefined => (s ? new Date(s + 'T00:00:00') : undefined);
