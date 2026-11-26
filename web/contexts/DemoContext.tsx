'use client';

import { createContext, useContext } from 'react';
import type { DemoSparklineData, DemoDisplayState } from '@/lib/demo-data';
import type { ChartDataPoint } from '@/hooks/useHistoricalMetrics';
import type { InstallerVersionInfo } from '@/hooks/useInstallerVersion';
import type { TimeRange } from '@/components/charts/TimeRangeSelector';

interface DemoContextType {
  isDemo: true;
  getSparklineData: (machineId: string) => DemoSparklineData;
  getHistoricalData: (machineId: string, timeRange: TimeRange) => ChartDataPoint[];
  getDisplayState: (machineId: string) => DemoDisplayState;
  /** the header's site switcher counts, by site id */
  siteMachineCounts: Readonly<Record<string, number>>;
  /** what the download buttons and the add machine dialog offer */
  latestInstaller: Pick<InstallerVersionInfo, 'version' | 'files'>;
  /** the phrase generate code shows; none is created */
  pairPhrase: string;
}

export const DemoContext = createContext<DemoContextType | null>(null);

export function useDemoContext() {
  return useContext(DemoContext);
}
