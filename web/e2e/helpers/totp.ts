import type { Page } from '@playwright/test';
import { authenticator } from 'otplib';

/** the last time step each secret was handed out for: the api takes a step once per account */
const spentStep = new Map<string, number>();

const currentStep = () => Math.floor(Date.now() / 1000 / authenticator.allOptions().step);

/**
 * a code the api will take for `secret`: from a step this run has not spent on it, with time
 * left before it rolls over. waits for the next step when it has to.
 */
export async function unspentTotp(page: Page, secret: string): Promise<string> {
  if (spentStep.get(secret) === currentStep() || authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  }
  spentStep.set(secret, currentStep());
  return authenticator.generate(secret);
}
