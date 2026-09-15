// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require('next/jest')

/** @type {import('jest').Config} */
const createJestConfig = nextJest({
  // Loads next.config.js + .env files into the test environment.
  dir: './',
})

const config = {
  clearMocks: true,

  collectCoverage: false,

  coverageDirectory: 'coverage',

  collectCoverageFrom: [
    'app/**/*.{js,jsx,ts,tsx}',
    'components/**/*.{js,jsx,ts,tsx}',
    'contexts/**/*.{js,jsx,ts,tsx}',
    'hooks/**/*.{js,jsx,ts,tsx}',
    'lib/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/.next/**',
    '!**/coverage/**',
    '!**/jest.config.js',
  ],

  testEnvironment: 'jsdom',

  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  moduleNameMapper: {
    // CSS modules
    '^.+\\.module\\.(css|sass|scss)$': 'identity-obj-proxy',

    // plain CSS
    '^.+\\.(css|sass|scss)$': '<rootDir>/__mocks__/styleMock.js',

    // images
    '^.+\\.(png|jpg|jpeg|gif|webp|avif|ico|bmp|svg)$': '<rootDir>/__mocks__/fileMock.js',

    // tsconfig path aliases
    '^@/(.*)$': '<rootDir>/$1',
  },

  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/.next/',
    '__tests__/api/helpers/',
    '/e2e/', // Playwright specs — use `npm run e2e`, not jest.
    '/e2e-live/', // Live dev smoke specs (playwright.live.config.ts) — Playwright, not jest.
    '/__tests__/rules/', // Firestore rules tests — use `npm run test:rules` (boots emulator).
  ],

  // NO blanket '/node_modules/' entry here, deliberately. next/jest builds its
  // own transformIgnorePatterns from `transpilePackages` in next.config.ts and
  // then APPENDS whatever this array holds. Patterns are OR'd, so a bare
  // '/node_modules/' re-ignores every package the carve-out just allowed —
  // which is exactly how the `ai` 7.x ESM-only upgrade appeared to be
  // untestable: 15 suites dying at load on "Cannot use import statement
  // outside a module" while the resolved config looked correct.
  // next/jest already excludes node_modules; this only adds the CSS-module
  // case. To let another package through, add it to transpilePackages.
  transformIgnorePatterns: [
    '^.+\\.module\\.(css|sass|scss)$',
  ],
}

// Exported as a call so next/jest can load the async Next.js config.
module.exports = createJestConfig(config)
