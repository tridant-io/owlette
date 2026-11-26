'use client';

import type { ReactNode } from 'react';
import { DemoContext } from '@/contexts/DemoContext';
import {
  DEMO_LATEST_INSTALLER,
  DEMO_PAIR_PHRASE,
  DEMO_SITE_MACHINE_COUNTS,
  getDemoDisplayState,
  getDemoHistoricalData,
  getDemoSparklineData,
} from '@/lib/demo-data';

const DEMO = {
  isDemo: true as const,
  getSparklineData: getDemoSparklineData,
  getHistoricalData: getDemoHistoricalData,
  getDisplayState: getDemoDisplayState,
  siteMachineCounts: DEMO_SITE_MACHINE_COUNTS,
  latestInstaller: DEMO_LATEST_INSTALLER,
  pairPhrase: DEMO_PAIR_PHRASE,
};

/**
 * the dashboard's hooks read this route's sample data from here instead of
 * firestore or the api. lives in app/demo, not beside DemoContext, so the
 * sample data stays out of the dashboard's bundle.
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  return <DemoContext.Provider value={DEMO}>{children}</DemoContext.Provider>;
}
