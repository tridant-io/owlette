/**
 * Live smoke global setup (playwright.live.config.ts), once before any spec:
 *
 *   1. Pin the web API key to owlette-dev-3838a before anything signs in with it.
 *   2. seed(): site smoke-live and the three persistent test users, every password rotated and
 *      held in memory only.
 *   3. Sign each LOGIN_ROLES role in through the real /login UI and save its storageState,
 *      IndexedDB included (the Firebase client keeps its signed-in user there), to
 *      e2e-live/.auth/<role>.json. The login technique is web/e2e/global-setup.ts's.
 *   4. smoke-siteadmin: store hoot's LLM key through the app when none is stored yet, or replace
 *      the stored one when SMOKE_LLM_REPLACE_KEY=1.
 *
 * Auth rate limit: POST /api/auth/session, every passkey route and POST /api/settings/llm-key
 * draw on one bucket of 10 a minute per public IP (web/lib/rateLimit.ts). A login here spends one
 * token, the AuthContext listener's session POST; the conditional passkey ceremony /login starts
 * on mount would spend a second, so it is switched off. A first-time LLM key spends one more.
 *
 * Playwright registers global teardown before this runs, so a failure here is cleaned up too.
 */
import {
  chromium,
  devices,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type FullConfig,
  type Page,
} from '@playwright/test';
import type { Credential } from 'firebase-admin/app';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DEV_ORIGIN, DEV_PROJECT_ID, getAuth, getWebApiKey } from './lib/devAdmin.mjs';
import { AUTH_DIR, LOGIN_ROLES, authStatePath, describeUrl, type LoginRole } from './lib/harness';
import { readLlmKeyProvider, seed } from './lib/seed.mjs';

const LOG = '[live-smoke setup]';
const DEBUG_DIR = path.join(__dirname, '.output', 'debug');
const DEV_HOST = new URL(DEV_ORIGIN).host;

/** Where the Firebase client SDK sends every Auth REST call, always with the web API key as `?key=`. */
const FIREBASE_AUTH_REQUEST = /^https:\/\/(identitytoolkit|securetoken)\.googleapis\.com\//;
/** indexedDBLocalPersistence — the Firebase JS SDK's default in a browser — keeps the signed-in user here. */
const FIREBASE_AUTH_DB = 'firebaseLocalStorageDb';
const FIREBASE_AUTH_STORE = 'firebaseLocalStorage';
/** The iron-session cookie the proxy gates every protected page on (web/lib/sessionManager.server.ts). */
const SESSION_COOKIE = '__session';
/** Where a password sign-in can land. The seed pre-empts both MFA pages; landing on one is a seed fault. */
const POST_LOGIN_PATHS = ['/dashboard', '/setup-2fa', '/verify-2fa'];

const LOGIN_TIMEOUT_MS = 30_000;
/** Blur/focus cycles to wait for hydration to mount the password field; see signIn(). */
const REVEAL_ATTEMPTS = 15;
/** How long a finished sign-in may take to persist both the session cookie and the Firebase user. */
const STATE_SETTLE_MS = 10_000;

const LLM_KEY_ROUTE = '/api/settings/llm-key';
const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
/** The auth rate limit's window; the longest one wait for it can need. */
const RATE_LIMIT_WINDOW_S = 60;

interface Credentials {
  uid: string;
  email: string;
  password: string;
}

/** The body POST /api/settings/llm-key takes. No model: the app default is what users get (plan Decision 7). */
interface LlmKeyInput {
  provider: LlmProvider;
  apiKey: string;
}

/** The key from the environment, and whether to replace a stored key with it (SMOKE_LLM_REPLACE_KEY=1). */
interface LlmKeyRequest {
  input: LlmKeyInput;
  replace: boolean;
}

interface SignedInSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
/** storageState({ indexedDB: true }) returns each origin's IndexedDB; Playwright's types omit it. */
type OriginWithIndexedDb = StorageState['origins'][number] & {
  indexedDB?: Array<{ name: string; stores?: Array<{ name: string; records?: unknown[] }> }>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Masks Google API keys, and any `key=` query value, in text echoed from the browser or an error. */
function redactSecrets(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{35}/g, '<redacted>').replace(/([?&]key=)[^&\s"']+/g, '$1<redacted>');
}

/**
 * An error's first line, redacted. Playwright appends a call log to its errors, and for an API
 * request that log lists every request header — the session cookie among them.
 */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text.split('\n', 1)[0]);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `: <status> <message>` from a Google API error body, redacted; empty when there is none. */
function googleError(body: Record<string, unknown> | null): string {
  const error = body?.error;
  if (typeof error !== 'object' || error === null) return '';
  const { status, message } = error as { status?: unknown; message?: unknown };
  const parts = [status, message].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? `: ${redactSecrets(parts.join(' '))}` : '';
}

/** owlette-dev-3838a's project number, read with the dev-pinned service account (Firebase Management API). */
async function readDevProjectNumber(): Promise<string> {
  const credential: Credential | undefined = getAuth().app.options.credential;
  if (!credential) throw new Error('the dev admin app carries no credential');
  const { access_token: accessToken } = await credential.getAccessToken();
  const res = await fetch(`https://firebase.googleapis.com/v1beta1/projects/${DEV_PROJECT_ID}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson(res);
  const projectNumber = body?.projectNumber;
  if (!res.ok || body?.projectId !== DEV_PROJECT_ID || typeof projectNumber !== 'string') {
    throw new Error(
      `could not read ${DEV_PROJECT_ID}'s project number (Firebase Management API HTTP ${res.status}${googleError(body)})`,
    );
  }
  return projectNumber;
}

/**
 * The project number `key` belongs to. Identity Toolkit's getProjectConfig reports it as
 * `projectId` — a number despite the name (535311475853 for dev, observed 2026-09-11).
 */
async function readKeyProjectNumber(key: string, source: string): Promise<string> {
  const url = new URL('https://identitytoolkit.googleapis.com/v1/projects');
  url.searchParams.set('key', key);
  let res: Response;
  try {
    // The site's Referer, so a key restricted to the site still answers.
    res = await fetch(url, { headers: { Referer: `${DEV_ORIGIN}/` } });
  } catch (err) {
    throw new Error(`could not reach Identity Toolkit to check ${source}: ${firstLine(err)}`);
  }
  const body = await readJson(res);
  const projectNumber = body?.projectId;
  if (!res.ok || typeof projectNumber !== 'string') {
    throw new Error(`Identity Toolkit did not resolve ${source} to a project (HTTP ${res.status}${googleError(body)})`);
  }
  return projectNumber;
}

/**
 * Proves a web API key belongs to owlette-dev-3838a: the project number Identity Toolkit reports
 * for the key must equal the one the dev-pinned service account reads for the project. Both
 * calls are read-only and sign nobody in. Each key is checked once, and a refusal is remembered.
 */
class DevWebApiKeyPin {
  private devProjectNumber: Promise<string> | null = null;
  private readonly checks = new Map<string, Promise<void>>();

  assertDev(key: string, source: string): Promise<void> {
    let check = this.checks.get(key);
    if (!check) {
      check = this.check(key, source);
      this.checks.set(key, check);
    }
    return check;
  }

  private async check(key: string, source: string): Promise<void> {
    this.devProjectNumber ??= readDevProjectNumber();
    const [devNumber, keyNumber] = await Promise.all([this.devProjectNumber, readKeyProjectNumber(key, source)]);
    if (keyNumber !== devNumber) {
      throw new Error(`ABORT: ${source} belongs to Firebase project number ${keyNumber}, not ${DEV_PROJECT_ID} (${devNumber})`);
    }
  }
}

/**
 * Let a Firebase Auth request out only when its `?key=` belongs to dev. The page signs in with
 * the key dev's own build carries, which need not be the env file's, so that key gets its own
 * check before the sign-in request — the one carrying the password — can leave. A refused
 * request is aborted; the returned getter reports the first refusal.
 */
async function guardFirebaseKeys(context: BrowserContext, pin: DevWebApiKeyPin): Promise<() => Error | null> {
  let refusal: Error | null = null;
  await context.route(FIREBASE_AUTH_REQUEST, async (route) => {
    const key = new URL(route.request().url()).searchParams.get('key');
    try {
      if (!key) throw new Error(`ABORT: ${describeUrl(route.request().url())} carried no API key`);
      await pin.assertDev(key, `the web API key ${DEV_ORIGIN} signs in with`);
    } catch (err) {
      refusal ??= toError(err);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return () => refusal;
}

/**
 * /login starts a WebAuthn conditional-UI ceremony on mount when the browser offers passkey
 * autofill, and its POST /api/passkeys/authenticate/options spends an auth-bucket token on every
 * visit. Reporting no autofill support skips it; the password path is untouched. The same stub
 * as web/e2e/specs/mfa/passkey-factor.spec.ts.
 */
function disableConditionalPasskeyUi(): void {
  const pkc = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential as
    | { isConditionalMediationAvailable?: () => Promise<boolean> }
    | undefined;
  if (pkc) pkc.isConditionalMediationAvailable = () => Promise.resolve(false);
}

/** Echo what explains a failed login: browser errors, failed requests, 4xx/5xx. URLs lose their query. */
function forwardDiagnostics(page: Page, role: LoginRole): void {
  const tag = `${LOG}[${role}]`;
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`${tag}[console.${msg.type()}] ${redactSecrets(msg.text())}`);
    }
  });
  page.on('pageerror', (err) => console.warn(`${tag}[pageerror] ${redactSecrets(err.message)}`));
  page.on('requestfailed', (req) =>
    console.warn(`${tag}[requestfailed] ${req.method()} ${describeUrl(req.url())}: ${req.failure()?.errorText ?? 'unknown'}`),
  );
  page.on('response', (res) => {
    if (res.status() >= 400) console.warn(`${tag}[${res.status()}] ${res.request().method()} ${describeUrl(res.url())}`);
  });
}

/**
 * A screenshot of a failed login for the post-mortem. Never the page HTML: React can mirror a
 * controlled input's value into its `value` attribute, so the markup could carry the password.
 */
async function saveFailureScreenshot(page: Page, role: LoginRole): Promise<void> {
  const file = path.join(DEBUG_DIR, `login-failure-${role}.png`);
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    console.error(`${LOG}[${role}] login failure screenshot: ${file}`);
  } catch (err) {
    console.error(`${LOG}[${role}] could not save a login failure screenshot: ${firstLine(err)}`);
  }
}

/** GET /api/auth/session (not rate limited) must report a session for exactly this uid. */
async function assertSessionIs(page: Page, role: LoginRole, uid: string): Promise<void> {
  let res: APIResponse;
  try {
    res = await page.request.get('/api/auth/session');
  } catch (err) {
    throw new Error(`${role}: GET /api/auth/session failed: ${firstLine(err)}`);
  }
  const body = res.ok() ? await res.json().catch(() => null) : null;
  if (body?.authenticated !== true || body.userId !== uid) {
    const found = body?.authenticated === true ? `uid ${String(body.userId)}` : 'no session';
    throw new Error(`${role}: GET /api/auth/session answered ${res.status()} with ${found}; expected ${uid}`);
  }
}

/** Sign `user` in through /login as a person would. Closes its own context when it fails. */
async function signIn(browser: Browser, role: LoginRole, user: Credentials, pin: DevWebApiKeyPin): Promise<SignedInSession> {
  // The specs' device profile (playwright.live.config.ts), so dev sees one kind of client.
  const context = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: DEV_ORIGIN, colorScheme: 'dark' });
  const close = async (): Promise<void> => {
    // Drop the key guard first: a Firebase call still waiting on it must not outlive the context.
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  };
  try {
    const refusal = await guardFirebaseKeys(context, pin);
    await context.addInitScript(disableConditionalPasskeyUi);
    const page = await context.newPage();
    forwardDiagnostics(page, role);
    console.log(`${LOG} ${role}: signing ${user.email} in through /login`);

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const emailField = page.getByLabel(/email/i);
    await emailField.fill(user.email);
    // The password field mounts on the email field's React onFocus. A fill() that lands before
    // hydration focuses the server-rendered input with no handler attached, so cycle
    // blur → focus until the field appears; once hydrated, one cycle opens it.
    const passwordField = page.getByLabel(/password/i).first();
    for (let attempt = 0; attempt < REVEAL_ATTEMPTS && !(await passwordField.isVisible()); attempt++) {
      await emailField.blur();
      await page.waitForTimeout(1_000);
      await emailField.focus();
    }
    // Hydration re-rendered the controlled input from its own empty state, wiping an early fill.
    await emailField.fill(user.email);
    await passwordField.fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();

    try {
      await page.waitForURL(
        (url) => url.origin === DEV_ORIGIN && POST_LOGIN_PATHS.some((prefix) => url.pathname.startsWith(prefix)),
        { timeout: LOGIN_TIMEOUT_MS },
      );
    } catch (err) {
      const refused = refusal();
      if (refused) throw refused;
      await saveFailureScreenshot(page, role);
      throw new Error(
        `${role}: sign-in did not reach /dashboard within ${LOGIN_TIMEOUT_MS / 1000} s ` +
          `(at ${describeUrl(page.url())}): ${firstLine(err)}`,
      );
    }
    const refusedAfterLogin = refusal();
    if (refusedAfterLogin) throw refusedAfterLogin;

    const landed = new URL(page.url()).pathname;
    if (!landed.startsWith('/dashboard')) {
      throw new Error(
        `${role}: sign-in landed on ${landed}, so the MFA bypass did not hold: ` +
          `users/${user.uid} needs mfaEnrolled false and requiresMfaSetup false (lib/seed.mjs)`,
      );
    }
    await assertSessionIs(page, role, user.uid);
    return { context, page, close };
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }
}

function hasSessionCookie(state: StorageState): boolean {
  return state.cookies.some((cookie) => cookie.name === SESSION_COOKIE && cookie.domain.replace(/^\./, '') === DEV_HOST);
}

function hasFirebaseUser(state: StorageState): boolean {
  const origin: OriginWithIndexedDb | undefined = state.origins.find((entry) => entry.origin === DEV_ORIGIN);
  return (origin?.indexedDB ?? []).some(
    (db) =>
      db.name === FIREBASE_AUTH_DB &&
      (db.stores ?? []).some((store) => store.name === FIREBASE_AUTH_STORE && (store.records?.length ?? 0) > 0),
  );
}

/**
 * Save the role's state once both halves have landed: the session cookie the proxy gates on and
 * the Firebase user in IndexedDB, without which every spec page would render signed out.
 */
async function saveSignedInState({ context }: SignedInSession, role: LoginRole): Promise<void> {
  const deadline = Date.now() + STATE_SETTLE_MS;
  for (;;) {
    const state = await context.storageState({ indexedDB: true });
    const missing = [
      hasSessionCookie(state) ? null : `the ${SESSION_COOKIE} cookie`,
      hasFirebaseUser(state) ? null : `the Firebase user in IndexedDB ${FIREBASE_AUTH_DB}`,
    ].filter((part): part is string => part !== null);
    if (missing.length === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `${role}: ${missing.join(' and ')} still missing ${STATE_SETTLE_MS / 1000} s after sign-in; ` +
          'a saved state would load signed out',
      );
    }
    await sleep(250);
  }
  const file = authStatePath(role);
  await context.storageState({ path: file, indexedDB: true });
  console.log(`${LOG} ${role}: signed-in state saved to ${file}`);
}

/**
 * SMOKE_LLM_API_KEY, with SMOKE_LLM_PROVIDER (default anthropic) and SMOKE_LLM_REPLACE_KEY; null when
 * no key is set. Checked before anything runs.
 */
function readLlmKeyRequest(): LlmKeyRequest | null {
  const replaceFlag = process.env.SMOKE_LLM_REPLACE_KEY?.trim() ?? '';
  if (replaceFlag !== '' && replaceFlag !== '1') {
    throw new Error(`SMOKE_LLM_REPLACE_KEY must be 1 when set, not '${replaceFlag}'`);
  }
  const replace = replaceFlag === '1';
  const apiKey = process.env.SMOKE_LLM_API_KEY?.trim();
  if (!apiKey) {
    if (replace) throw new Error('SMOKE_LLM_REPLACE_KEY=1 replaces the stored key with SMOKE_LLM_API_KEY, which is not set');
    return null;
  }
  const requested = (process.env.SMOKE_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const provider = LLM_PROVIDERS.find((candidate) => candidate === requested);
  if (!provider) {
    throw new Error(`SMOKE_LLM_PROVIDER must be ${LLM_PROVIDERS.join(' or ')}, not '${requested}'`);
  }
  return { input: { provider, apiKey }, replace };
}

/**
 * The route stores whatever it is given, and a key saved under the wrong provider fails every hoot
 * turn until it is replaced. Refuse the unambiguous mismatches before storing: Anthropic keys start
 * `sk-ant-`, and an `sk-` key without it is an OpenAI one. Other shapes pass. Never prints the key.
 */
function assertKeyFitsProvider({ provider, apiKey }: LlmKeyInput): void {
  const anthropicShaped = apiKey.startsWith('sk-ant-');
  if (provider === 'openai' && anthropicShaped) {
    throw new Error('SMOKE_LLM_API_KEY is an Anthropic key (sk-ant-) but SMOKE_LLM_PROVIDER is openai; nothing was stored');
  }
  if (provider === 'anthropic' && !anthropicShaped && apiKey.startsWith('sk-')) {
    throw new Error(
      'SMOKE_LLM_API_KEY looks like an OpenAI key (sk-, not sk-ant-) but SMOKE_LLM_PROVIDER is anthropic ' +
        '(the default); set SMOKE_LLM_PROVIDER=openai. Nothing was stored',
    );
  }
}

/**
 * ` (message)` from an error the app answered with. The route's own errors are fixed strings and
 * apiError sanitizes the rest in production (web/lib/apiErrorResponse.ts).
 */
async function errorDetail(res: APIResponse): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail = [body?.error, body?.detail, body?.message].find((part) => typeof part === 'string');
  return detail ? ` (${redactSecrets(detail).slice(0, 200)})` : '';
}

/** POST the key as the page's signed-in user, waiting out one auth rate-limit refusal. */
async function postLlmKey(page: Page, input: LlmKeyInput): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let res: APIResponse;
    try {
      res = await page.request.post(LLM_KEY_ROUTE, { data: input });
    } catch (err) {
      throw new Error(`POST ${LLM_KEY_ROUTE} failed: ${firstLine(err)}`);
    }
    if (res.ok()) return;
    if (res.status() === 429 && attempt === 1) {
      const retryAfter = Number(res.headers()['retry-after']);
      const waitS = Math.min(retryAfter > 0 ? retryAfter : RATE_LIMIT_WINDOW_S, RATE_LIMIT_WINDOW_S) + 1;
      console.warn(`${LOG} POST ${LLM_KEY_ROUTE} was rate limited; retrying in ${waitS} s`);
      await sleep(waitS * 1000);
      continue;
    }
    throw new Error(`POST ${LLM_KEY_ROUTE} answered ${res.status()}${await errorDetail(res)}`);
  }
}

/**
 * hoot answers only with a per-user LLM key (users/{uid}/settings/llm, resolveLlmConfig in
 * web/lib/hoot-utils.server.ts), encrypted with a secret that exists only on dev. So it is saved
 * through the app's own POST /api/settings/llm-key as the signed-in user: when none is stored, or,
 * with SMOKE_LLM_REPLACE_KEY=1, over the stored one (the route overwrites provider, ciphertext and
 * model). This process only ever reads the document. Neither the key nor the request body is logged.
 */
async function ensureHootLlmKey(page: Page, uid: string, request: LlmKeyRequest | null): Promise<void> {
  const storedProvider = await readLlmKeyProvider(uid);
  if (storedProvider !== null && !request?.replace) {
    if (request) {
      console.log(`${LOG} ${uid} already has an LLM key stored (${storedProvider}); SMOKE_LLM_API_KEY was not used`);
      if (storedProvider !== request.input.provider) {
        console.warn(
          `${LOG} WARNING: the stored key is for ${storedProvider} and SMOKE_LLM_PROVIDER says ${request.input.provider}. ` +
            `If the stored key is the wrong one, re-run once with SMOKE_LLM_REPLACE_KEY=1 to replace it through POST ${LLM_KEY_ROUTE}.`,
        );
      }
    }
    return;
  }
  if (!request) {
    console.warn(
      [
        `${LOG} WARNING: ${uid} has no hoot LLM key stored and SMOKE_LLM_API_KEY is not set.`,
        `${LOG}          The hoot checks will fail ("No LLM API key configured").`,
        `${LOG}          Set SMOKE_LLM_API_KEY (plus SMOKE_LLM_PROVIDER=openai for an OpenAI key)`,
        `${LOG}          and re-run: setup stores it once, through POST ${LLM_KEY_ROUTE}.`,
      ].join('\n'),
    );
    return;
  }
  const { input } = request;
  assertKeyFitsProvider(input);
  await postLlmKey(page, input);
  const nowStored = await readLlmKeyProvider(uid);
  if (nowStored !== input.provider) {
    throw new Error(
      `POST ${LLM_KEY_ROUTE} succeeded, yet users/${uid}/settings/llm reads ${nowStored ?? 'missing'}, not ${input.provider}`,
    );
  }
  const verb = storedProvider === null ? 'stored' : `replaced (was ${storedProvider})`;
  console.log(`${LOG} ${uid}: LLM key ${verb} through POST ${LLM_KEY_ROUTE} (${input.provider}, app default model)`);
}

/**
 * The config pins its own literal host (it cannot import devAdmin.mjs), while this setup and the
 * fixtures use devAdmin's DEV_ORIGIN. Sign-in states are bound to one origin, so the two must match.
 */
function assertConfigTargetsDevOrigin(config: FullConfig): void {
  for (const project of config.projects) {
    if (project.use.baseURL !== DEV_ORIGIN) {
      throw new Error(`ABORT: project '${project.name}' baseURL is ${String(project.use.baseURL)}, not ${DEV_ORIGIN}`);
    }
  }
}

/** seed.mjs is untyped JavaScript: check the credentials it returned rather than assert their type. */
function credentialsFor(seeded: { users: unknown }, role: LoginRole): Credentials {
  const users = seeded.users as Partial<Record<LoginRole, Partial<Record<keyof Credentials, unknown>>>> | undefined;
  const { uid, email, password } = users?.[role] ?? {};
  if (typeof uid !== 'string' || typeof email !== 'string' || typeof password !== 'string' || password === '') {
    throw new Error(`seed() returned no usable credentials for ${role}`);
  }
  return { uid, email, password };
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  assertConfigTargetsDevOrigin(config);
  const llmKeyRequest = readLlmKeyRequest();

  // A crashed run can leave states behind; no spec may start from one.
  rmSync(AUTH_DIR, { recursive: true, force: true });
  mkdirSync(AUTH_DIR, { recursive: true });

  const pin = new DevWebApiKeyPin();
  await pin.assertDev(getWebApiKey(), 'NEXT_PUBLIC_FIREBASE_API_KEY in the web env file');
  console.log(`${LOG} web API key belongs to ${DEV_PROJECT_ID}`);

  const seeded = await seed();

  const browser = await chromium.launch();
  try {
    for (const role of LOGIN_ROLES) {
      const user = credentialsFor(seeded, role);
      const session = await signIn(browser, role, user, pin);
      try {
        await saveSignedInState(session, role);
        if (role === 'siteadmin') await ensureHootLlmKey(session.page, user.uid, llmKeyRequest);
      } finally {
        await session.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`${LOG} done: ${LOGIN_ROLES.length} UI logins`);
}
