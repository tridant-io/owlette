'use client';

import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { usePasskeyPrompt } from '@/hooks/usePasskeyPrompt';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import type { MfaFactorInventory } from '@/lib/mfaFactors.server';
import {
  passkeyElsewhereHint,
  secondFactorChoices,
  type SecondFactorChoices,
} from '@/lib/secondFactors';

/**
 * the second factors this page may ask this account for (`lib/secondFactors.ts`),
 * and, when its passkey cannot run here, the sentence that says how to use it.
 */
export function useSecondFactorChoices(
  factors: MfaFactorInventory,
): SecondFactorChoices & { passkeyHint: string | null } {
  const passkeyPrompt = usePasskeyPrompt();
  const inApp = useInAppBrowser();
  const viewerApp = useViewerAppPlatform() !== null;
  const choices = secondFactorChoices(factors, passkeyPrompt);
  return {
    ...choices,
    passkeyHint: choices.passkeyElsewhere ? passkeyElsewhereHint({ viewerApp, inApp }) : null,
  };
}
