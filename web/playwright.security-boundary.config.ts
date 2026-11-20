import { defineConfig } from '@playwright/test';

const REPORT_DIR = './e2e/.output/report/security-boundary';

export default defineConfig({
  testDir: './e2e/specs/security-boundary',
  tsconfig: './tsconfig.security-boundary.json',
  outputDir: './e2e/.output/results/security-boundary',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${REPORT_DIR}/playwright` }],
  ],
});
