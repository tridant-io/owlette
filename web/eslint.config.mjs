import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const systemInvokerImportMessage =
  "systemInvoker.server may only be imported from web/lib/hoot/**, web/lib/jobs/**, or web/__tests__/**. " +
  "Use authorizedHandler for user-facing routes. Keep this rule in sync with scripts/check-system-invoker-callers.mjs.";

// Editor-time guard against logging auth tokens (roost wave 5.10). The
// authoritative CI gate is `scripts/check-no-token-logs.mjs`, which also covers
// python and template literals. Exempt a line with `// no-token-logs-allow`.
const noTokenLogsRule = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.object.name='console'] Identifier[name=/^(token|tokens|bearer|authorization|accessToken|refreshToken|idToken|access_token|refresh_token|id_token|apiKey|api_key|clientSecret|client_secret|authCode|auth_code)$/i]",
  message:
    "Do not log auth tokens or credentials. Use a stable non-sensitive identifier (user id, site id, request id) instead. See `scripts/check-no-token-logs.mjs`.",
};

// Rule B of the wave-2.1 security-boundary work, written 2026-09-07 — four months
// after the test that claimed to cover it. CLAUDE.md's landmine "never call
// Firestore directly from components" had NO enforcement: the test asserted the
// rule's ABSENCE (it passed BECAUSE nothing flagged), and the allowlist JSON
// beside it had no reader and named a file the hoot rebrand had renamed away.
//
// Rule A of that pair ("no raw route exports under app/api/**") was deliberately
// NOT written. This codebase has two sanctioned authorization paths
// (authorizedSiteHandler and requireSiteAuthAndScope — see
// __tests__/lib/authorizationParity.test.ts) plus ~75 routes that legitimately
// use neither: cron secrets, agent and CLI device tokens, webhook receivers,
// passkeys, health, openapi, legal. It would flag 127 of 186 route files, which
// is noise at any severity.
//
// Named imports only: `import * as fb from 'firebase/firestore'` then
// `fb.setDoc()` slips through. That shape appears nowhere in web/ today, and
// scripts/scan-firestore-writes.mjs walks method-style `.set()`/`.update()` as
// the deeper net.
const noClientFirestoreWritesRule = {
  selector:
    "ImportDeclaration[source.value='firebase/firestore'] > ImportSpecifier[imported.name=/^(setDoc|updateDoc|deleteDoc|addDoc|writeBatch|runTransaction)$/]",
  message:
    "Direct firestore client writes are not allowed here. Route the write through an API handler (web/lib/actions/*.server.ts), or add the file to the preference allowlist in eslint.config.mjs if it is genuinely per-device state.",
};

// Light mode (2026-10): every colour is a theme token, so a raw palette utility
// is a colour that will not change with the theme. Server code (emails, webhook
// embeds) and tests sit in the allowlist block below and keep raw colour. A
// theme-invariant spot (white on a black scrim) takes an inline
// `eslint-disable-next-line no-restricted-syntax -- <why>`. `\b` also stops at
// a variant colon, so `hover:text-red-400` is caught.
const RAW_PALETTE =
  "\\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|caret|accent)-(?:red|green|emerald|amber|yellow|orange|blue|sky|cyan|teal|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|lime|indigo|fuchsia)-\\d{2,3}\\b|\\btext-(?:white|gray-900)\\b";
const rawPaletteMessage = "use a theme token (see DESIGN.md), not a raw palette colour";
const noRawPaletteRules = [
  { selector: `Literal[value=/${RAW_PALETTE}/]`, message: rawPaletteMessage },
  { selector: `TemplateElement[value.raw=/${RAW_PALETTE}/]`, message: rawPaletteMessage },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Honor `_`-prefixed identifiers as intentionally unused.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "no-restricted-syntax": ["error", noTokenLogsRule, noClientFirestoreWritesRule, ...noRawPaletteRules],
    },
  },
  // Server code, tests, and the per-device preference hooks may write directly.
  // This `files:` array IS the allowlist — the old JSON file had no reader.
  //
  // CRITICAL: flat-config rule OPTIONS REPLACE rather than merge, so
  // `noTokenLogsRule` MUST be repeated here. Dropping it would silently disable
  // the token-logging guard for app/api/** and lib/**/*.server.ts — precisely
  // the files that handle tokens.
  {
    files: [
      "app/api/**/*.{ts,tsx}",
      "lib/**/*.server.ts",
      "__tests__/**/*.{ts,tsx}",
      "e2e/**/*.ts",
      "contexts/AuthContext.tsx",
      "hooks/useDevicePrefs.ts",
      "hooks/useDevicePrefFlag.ts",
      "hooks/useHoot.ts",
      "hooks/useHootSidebarPrefs.ts",
    ],
    rules: { "no-restricted-syntax": ["error", noTokenLogsRule] },
  },
  // Editor-time system-actor import boundary (wave 2.3). CI gate is
  // `scripts/check-system-invoker-callers.mjs` — update both together.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/systemInvoker.server",
              message: systemInvokerImportMessage,
            },
            {
              name: "@/lib/systemInvoker.server.ts",
              message: systemInvokerImportMessage,
            },
          ],
          patterns: [
            {
              group: [
                "**/lib/systemInvoker.server",
                "**/lib/systemInvoker.server.ts",
              ],
              message: systemInvokerImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "lib/hoot/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "lib/jobs/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "__tests__/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "lib/systemInvoker.server.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "coverage/**",
    "e2e/.output/**",
    "e2e-live/.output/**",
    ".source/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
