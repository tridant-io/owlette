'use client';

import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  getAdditionalUserInfo,
  signInWithPopup,
  updateProfile,
  updatePassword as firebaseUpdatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, db, storage } from '@/lib/firebase';
import { handleError, logError } from '@/lib/errorHandler';
import { inAppDiagnostics, isPopupUnavailableError } from '@/lib/inAppBrowser';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { toast } from '@/lib/toast';
import * as Sentry from '@sentry/nextjs';
// Type-only: mfaFactors.server.ts is Admin-SDK code that must never reach the
// client bundle; `import type` is erased at compile time.
import type { MfaFactorInventory } from '@/lib/mfaFactors.server';
import { useSiteMemberships, unionMembership, type SiteRole } from '@/hooks/useFirestore';
import { emitMembershipFallback, emitMembershipListenerError } from '@/lib/membershipMetrics';

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Codes meaning the credential is gone, not that the operation failed. The SDK
// signs out before surfacing these (`_logoutIfInvalidated`), so the auth
// listener owns the message — a per-operation toast would blame the wrong thing
// ("Photo Update Failed") and the Sentry report would be noise.
const SESSION_ENDED_CODES = new Set(['auth/user-token-expired', 'auth/invalid-user-token']);

function isSessionEndedError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code !== undefined && SESSION_ENDED_CODES.has(code);
}

// Not JSON.stringify: Firestore does not guarantee key order, so stringify
// equality produces spurious mismatches and reference churn downstream.
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!isDeepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/** Last hoot target per site: the site sentinel, one machine id, or a set. */
export type LastMachineSelection = string | string[];

/**
 * Read `users/{uid}.lastMachineIds`. Values gained a list form when a hoot chat
 * could target a SET of machines, so old entries (a single id or the site
 * sentinel) and new ones coexist and both have to survive a round trip.
 *
 * Sanitized rather than trusted: this value picks the machines a turn dispatches
 * to, and an entry that isn't a string or a non-empty list of strings is dropped
 * instead of being carried into a selection. (The empty list is never a valid
 * target — see `lib/hoot/target.ts`.)
 */
function readLastMachineIds(raw: unknown): Record<string, LastMachineSelection> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const parsed: Record<string, LastMachineSelection> = {};
  for (const [siteId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      parsed[siteId] = value;
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((id) => typeof id === 'string')
    ) {
      parsed[siteId] = value as string[];
    }
  }
  return parsed;
}

// Local literal, not an import of `EMPTY_MFA_FACTORS`: importing that VALUE
// from a `.server` module would drag the Admin SDK into the client bundle.
// Frozen because it is shared by the default context value and initial state.
const NO_MFA_FACTORS: MfaFactorInventory = Object.freeze({ totp: false, passkeys: 0 });

// The projection before access has resolved: no site list yet, and nothing to
// count as a fallback. One shared instance so `fallbacks` keeps its identity
// across renders and the fallback-metric effect doesn't re-run on it.
const UNRESOLVED_MEMBERSHIP: { sites: undefined; fallbacks: readonly string[] } = Object.freeze({
  sites: undefined,
  fallbacks: Object.freeze([]),
});

/**
 * Read the second-factor tally off a user document. `users/{uid}.mfaFactors` is
 * written only by `lib/mfaFactors.server.ts`, transactionally with the
 * `passkeys` subcollection. Parsed defensively: the field is absent on older
 * accounts, and a malformed value must read as "no factors" rather than
 * accidentally satisfying a "has a passkey" check.
 */
function readMfaFactorsFromDoc(userData: Record<string, unknown>): MfaFactorInventory {
  const raw = userData.mfaFactors;
  if (typeof raw !== 'object' || raw === null) return NO_MFA_FACTORS;
  const { totp, passkeys } = raw as { totp?: unknown; passkeys?: unknown };
  return {
    totp: totp === true,
    passkeys:
      typeof passkeys === 'number' && Number.isInteger(passkeys) && passkeys > 0
        ? passkeys
        : 0,
  };
}

const createSessionCookie = async (userId: string, idToken: string): Promise<void> => {
  try {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, idToken }),
    });

    if (!response.ok) {
      console.error('[Session] Failed to create session:', await response.text());
    }
  } catch (error) {
    console.error('[Session] Failed to create session:', error);
  }
};

const destroySessionCookie = async (): Promise<void> => {
  try {
    const response = await fetch('/api/auth/session', {
      method: 'DELETE',
    });

    if (!response.ok) {
      console.error('[Session] Failed to destroy session:', await response.text());
    }
  } catch (error) {
    console.error('[Session] Failed to destroy session:', error);
  }
};

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

const bootstrapUserDocument = async (
  user: User,
  displayName: string,
  /**
   * Turnstile token from the register form. Omitted on the auth-state listener
   * path (Google / recovery) — the server skips the challenge there.
   */
  turnstileToken?: string
): Promise<{ alreadyExists: boolean }> => {
  const idToken = await user.getIdToken();
  const response = await fetch('/api/users/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      email: user.email,
      displayName,
      timezone: getBrowserTimezone(),
      ...(turnstileToken ? { 'cf-turnstile-response': turnstileToken } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<{ alreadyExists: boolean }>;
};

/**
 * Should the auth-state listener run its own bootstrap for a user whose doc is
 * missing? Not while signUp's is still in flight: that call carries the register
 * form's Turnstile token and this path has none, so racing it spent a rejected
 * challenge on every email/password signup. Waiting also preserves the reason
 * this path exists — a signUp bootstrap that genuinely FAILED still falls
 * through to the recovery attempt. Exported so it's testable without
 * AuthProvider.
 */
export async function shouldListenerBootstrap(
  pendingSignUpBootstrap: Promise<unknown> | null
): Promise<boolean> {
  if (!pendingSignUpBootstrap) return true;
  try {
    await pendingSignUpBootstrap;
    return false;
  } catch {
    return true;
  }
}

export type UserRole = 'member' | 'admin' | 'superadmin';

/** Platform-wide superadmin? Exported so it's testable without AuthProvider. */
export function computeIsSuperadmin(role: UserRole | null): boolean {
  return role === 'superadmin';
}

/**
 * Site-admin for `siteId`? Superadmins pass for every site; everyone else needs
 * an `owner` or `admin` role on that specific site.
 *
 * The global role no longer participates beyond superadmin: a global `admin` is
 * worth nothing on a site it holds no membership for, which is the whole point of
 * per-site roles. Owners rank above admins and satisfy this too.
 *
 * Exported so it's testable without AuthProvider.
 */
export function computeIsSiteAdmin(
  role: UserRole | null,
  roleMap: Map<string, SiteRole>,
  siteId: string
): boolean {
  if (role === 'superadmin') return true;
  // A null global role means the user document has not resolved — pre-auth, doc
  // missing, or the listener errored. Membership alone must not grant off a
  // half-loaded session, so this stays fail-closed exactly as it was before the
  // role map replaced `sites[]`.
  if (role === null) return false;
  const siteRole = roleMap.get(siteId);
  return siteRole === 'owner' || siteRole === 'admin';
}

/**
 * Owner of `siteId`? The only capability owners hold that admins do not is
 * SITE_DELETE, so this exists to gate that one control on the same standing the
 * server checks.
 *
 * Reads the role map, never `sites/{siteId}.owner` — the legacy field is
 * stripped in wave 6.1 and a control gated on it would silently stop rendering.
 *
 * Exported so it's testable without AuthProvider.
 */
export function computeIsSiteOwner(
  role: UserRole | null,
  roleMap: Map<string, SiteRole>,
  siteId: string
): boolean {
  if (role === 'superadmin') return true;
  if (role === null) return false;
  return roleMap.get(siteId) === 'owner';
}

/**
 * Does this user administer ANY site? The entry predicate for the admin panel's
 * site-scoped half (members, tokens, schedules, alerts, webhooks).
 *
 * It replaces `role === 'admin'`, which since wave 5.1 grants nothing: a global
 * admin with no membership could still open those pages, see an empty site list
 * on every one, and have each write refused. The panel now admits exactly the
 * users the server will actually let act.
 *
 * Superadmins pass without a membership, as everywhere else.
 *
 * Exported so it's testable without AuthProvider.
 */
export function computeAdministersAnySite(
  role: UserRole | null,
  roleMap: Map<string, SiteRole>
): boolean {
  if (role === 'superadmin') return true;
  if (role === null) return false;
  for (const siteRole of roleMap.values()) {
    if (siteRole === 'owner' || siteRole === 'admin') return true;
  }
  return false;
}

export interface UserPreferences {
  temperatureUnit: 'C' | 'F'; // Default: 'C'
  timezone: string; // IANA timezone (e.g. 'America/New_York'). Default: browser-detected. Used as the display reference frame when timeDisplayMode === 'user'.
  timeFormat: '12h' | '24h'; // Time display format. Default: '12h'
  /** Reference frame for absolute timestamps on the dashboard. 'user' = the
   * `timezone` above; 'machine' = each machine's own tz (default, best for
   * distributed kiosks); 'site' = the site's configured tz. Schedule editors
   * ignore this — always machine-local with an explicit chip label. */
  timeDisplayMode: 'user' | 'machine' | 'site';
  healthAlerts: boolean; // Receive email alerts when machines go offline. Default: true
  processAlerts: boolean; // Receive email alerts when processes crash or fail to start. Default: true
  thresholdAlerts: boolean; // Receive email alerts when health metrics exceed thresholds. Default: true
  cortexAlerts: boolean; // Receive email alerts when Cortex AI escalates unresolved issues. Default: true
  displayAlerts: boolean; // Receive email alerts when display layout / topology events fire (drift, monitor removed, apply failed, auto-revert, etc). Default: true
  talonAlerts: boolean; // Receive email alerts when a talon (automation) fires or fails. Default: true
  apiKeyAlerts: boolean; // Receive email notices before one of your api keys expires (14 / 3 / 0 days out). Default: true
  displayAlertsBannerDismissed: boolean; // [B4.3] One-shot dismissal of the "new: display alerts" banner on /admin/alerts. Default: false (banner shows). The banner also auto-hides after 30 days from feature launch regardless of dismissal state.
  mutedMachines: string[]; // Machine IDs to suppress all alerts for. Default: []
  alertCcEmails: string[]; // Additional CC recipients for alert emails. Default: []
  statsExpanded: boolean; // Whether stats section is expanded in card view. Default: false
  processesExpanded: boolean; // Whether process list is expanded in card view. Default: false
  displaysExpanded?: boolean; // Whether displays section is expanded in card view. Default: false
  /** machineId → namespaced tab ids ('metric:cpu', 'nic:Ethernet 2', 'gpu:0').
   * Unknown namespaces are ignored on read, so new entity types need no migration. */
  graphTabs?: Record<string, string[]>;
  /** Open MetricsDetailPanel + the metric that opened it; null when closed.
   * Persisted so the panel reappears after reload. */
  activeGraphPanel?: { machineId: string; metric: string } | null;
  /** MetricsDetailPanel range, global not per-machine: '1h'|'1d'|'1w'|'1m'|'1y'|'all'. Default '1h'. */
  graphTimeRange?: '1h' | '1d' | '1w' | '1m' | '1y' | 'all';
}

/**
 * Outcome of a Google sign-in. One popup does both signup and signin, so
 * without `isNewUser` (from `getAdditionalUserInfo`) /register claimed "account
 * created with Google!" for returning users. A small domain object rather than
 * the raw `UserCredential` to keep the Firebase type out of pages.
 */
export interface GoogleSignInResult {
  isNewUser: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  /** User's role from Firestore; null until the user doc loads (pre-auth, missing doc, or listener error). */
  role: UserRole | null;
  /** role === 'superadmin'. Installer uploads, role management, cross-site admining. */
  isSuperadmin: boolean;
  /** Admin or superadmin of `siteId`. Gates site-level elevated ops (delete machines, stored layouts, site webhooks/settings). */
  isSiteAdmin: (siteId: string) => boolean;
  /** Administers at least one site — the admin panel's site-scoped entry gate. */
  administersAnySite: boolean;
  /** Owner of this site. Gates SITE_DELETE, the one owner-only capability. */
  isSiteOwner: (siteId: string) => boolean;
  /**
   * Sites the user has access to, or `undefined` until access has RESOLVED: the
   * user doc (role, legacy `sites[]`, `lastSiteId`) and the membership listener
   * have both delivered for the signed-in uid. Before that the projection is a
   * half-read — membership rows can land while `role` is still null, so a
   * superadmin looks like a member of a few sites — and anything that picks a
   * default site from it picks the wrong one. `useSites` waits on `undefined`.
   */
  userSites: string[] | undefined;
  lastSiteId: string | null; // Last active site (synced to Firestore)
  lastMachineIds: Record<string, LastMachineSelection>; // Last hoot target per site (synced to Firestore)
  requiresMfaSetup: boolean; // Whether user needs to complete 2FA setup
  /** Second factors, mirrored live from the user doc. `totp || passkeys > 0` === `mfaEnrolled`. */
  mfaFactors: MfaFactorInventory;
  userPreferences: UserPreferences; // User preferences (temperature unit, etc.)
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, firstName?: string, lastName?: string, turnstileToken?: string) => Promise<void>;
  signInWithGoogle: () => Promise<GoogleSignInResult>;
  signOut: () => Promise<void>;
  updateUserProfile: (firstName: string, lastName: string) => Promise<void>;
  updateUserPhoto: (photoBlob: Blob | null) => Promise<void>;
  updatePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Resolves even for unknown addresses (enumeration protection) — callers must show a generic confirmation. */
  sendPasswordReset: (email: string, turnstileToken?: string) => Promise<void>;
  updateUserPreferences: (preferences: Partial<UserPreferences>, options?: { silent?: boolean }) => Promise<void>;
  updateLastSite: (siteId: string) => void;
  updateLastMachine: (siteId: string, selection: LastMachineSelection) => void;
  deleteAccount: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  role: null,
  isSuperadmin: false,
  isSiteAdmin: () => false,
  administersAnySite: false,
  isSiteOwner: () => false,
  userSites: [],
  lastSiteId: null,
  lastMachineIds: {},
  requiresMfaSetup: false,
  mfaFactors: NO_MFA_FACTORS,
  userPreferences: { temperatureUnit: 'C', timezone: 'UTC', timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, displayAlerts: true, talonAlerts: true, apiKeyAlerts: true, displayAlertsBannerDismissed: false, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true },
  signIn: async () => {},
  signUp: async () => {},
  signInWithGoogle: async () => ({ isNewUser: false }),
  signOut: async () => {},
  updateUserProfile: async () => {},
  updateUserPhoto: async () => {},
  updatePassword: async () => {},
  sendPasswordReset: async () => {},
  updateUserPreferences: async () => {},
  updateLastSite: () => {},
  updateLastMachine: () => {},
  deleteAccount: async () => {},
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<UserRole | null>(null);
  // The LEGACY `users/{uid}.sites[]` array. No longer the source of site access —
  // it is unioned with membership below for one release, and the gap between the
  // two is what `membership_fallback` counts. Deleted in wave 6.1.
  const [legacySites, setLegacySites] = useState<string[]>([]);
  const [requiresMfaSetup, setRequiresMfaSetup] = useState(false);
  const [mfaFactors, setMfaFactors] = useState<MfaFactorInventory>(NO_MFA_FACTORS);
  const [userPreferences, setUserPreferences] = useState<UserPreferences>({ temperatureUnit: 'C', timezone: getBrowserTimezone(), timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, displayAlerts: true, talonAlerts: true, apiKeyAlerts: true, displayAlertsBannerDismissed: false, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true });
  // Ref mirror so updateUserPreferences reads current prefs without listing
  // them in its deps — that caused stale closures to clobber rapid stacked
  // updates (cell-click + sparkline-toggle).
  const userPreferencesRef = useRef(userPreferences);
  useEffect(() => { userPreferencesRef.current = userPreferences; }, [userPreferences]);
  // Deliberate = from `signOut` or account deletion; anything else means the
  // credential was revoked underneath us and the listener owes an explanation
  // (the SDK signs out from inside whichever call happened to notice).
  const intentionalSignOutRef = useRef(false);
  // `onAuthStateChanged` fires null on first load too, so an involuntary
  // sign-out only counts for a session that was actually signed in.
  const hadUserRef = useRef(false);
  // signUp's in-flight bootstrap, held so the doc listener can wait on it
  // instead of racing a second, tokenless one — see shouldListenerBootstrap.
  const signUpBootstrapRef = useRef<Promise<{ alreadyExists: boolean }> | null>(null);
  const [lastSiteId, setLastSiteId] = useState<string | null>(null);
  const [lastMachineIds, setLastMachineIds] = useState<Record<string, LastMachineSelection>>({});
  // The uid whose user doc the listener has settled — delivered, or failed for
  // good. Not `!loading`: a sign-in without a reload never re-arms `loading`, so
  // it would read "resolved" before the new user's doc has arrived.
  const [userDocUid, setUserDocUid] = useState<string | null>(null);

  const sendUserCreatedNotification = async (
    email: string,
    displayName: string,
    authMethod: 'email' | 'google'
  ) => {
    try {
      let idToken: string | null = null;
      if (auth?.currentUser) {
        try {
          idToken = await auth.currentUser.getIdToken();
        } catch (tokenError) {
          console.warn('Failed to get ID token for notification:', tokenError);
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }

      const response = await fetch('/api/webhooks/user-created', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          displayName,
          authMethod,
          createdAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ status: response.status }));
        console.error('Failed to send user creation notification:', error);
      }
    } catch (error) {
      // Notification failure must not fail user creation.
      console.error('Error sending user creation notification:', error);
    }
  };

  useEffect(() => {
    if (!auth || !db) {
      setLoading(false);
      return;
    }

    let userDocUnsubscribe: (() => void) | null = null;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);

      if (user) {
        Sentry.setUser({ id: user.uid, email: user.email || undefined });
      } else {
        Sentry.setUser(null);
      }

      if (userDocUnsubscribe) {
        userDocUnsubscribe();
        userDocUnsubscribe = null;
      }

      if (user) {
        hadUserRef.current = true;
        // Mint the HTTPOnly session cookie.
        try {
          const idToken = await user.getIdToken();
          await createSessionCookie(user.uid, idToken);
        } catch (error) {
          console.error('[Session] Failed to get ID token:', error);
        }

        if (db) {
          const userDocRef = doc(db, 'users', user.uid);

          userDocUnsubscribe = onSnapshot(
            userDocRef,
            async (docSnap) => {
              if (docSnap.exists()) {
                const userData = docSnap.data();
                const rawRole = userData.role;
                // `'user'` maps onto the same tier as `'member'`. Wave 5.2 rewrites
                // every non-superadmin global role to `'user'`, and a parser that
                // returned null for it would strip a live session's role mid-flight
                // — every site-admin control vanishing from an open tab with no
                // reload. Accept both spellings before that migration runs, not after.
                const newRole: UserRole | null =
                  rawRole === 'superadmin' || rawRole === 'admin'
                    ? rawRole
                    : rawRole === 'member' || rawRole === 'user'
                      ? 'member'
                      : null;
                const newSites: string[] = userData.sites || [];
                const newRequiresMfa = userData.requiresMfaSetup || false;
                const newMfaFactors = readMfaFactorsFromDoc(userData);
                const newLastSiteId = userData.lastSiteId || null;
                const newLastMachineIds = readLastMachineIds(userData.lastMachineIds);

                // Identity-preserving setters: avoid re-renders on equal values.
                setRole(prev => prev === newRole ? prev : newRole);
                setLegacySites(prev => arraysEqual(prev, newSites) ? prev : newSites);
                setRequiresMfaSetup(prev => prev === newRequiresMfa ? prev : newRequiresMfa);
                setMfaFactors(prev =>
                  prev.totp === newMfaFactors.totp && prev.passkeys === newMfaFactors.passkeys
                    ? prev
                    : newMfaFactors
                );
                setLastSiteId(prev => prev === newLastSiteId ? prev : newLastSiteId);
                // Deep, not shallow: a per-site value can be a LIST now, and a
                // shallow compare sees two equal lists as a change on every
                // snapshot — churning the context value for the whole app.
                setLastMachineIds(prev => isDeepEqual(prev, newLastMachineIds) ? prev : newLastMachineIds);

                const preferences = userData.preferences || {};
                // Unknown/missing timeDisplayMode falls back to 'machine'.
                const rawTdm = preferences.timeDisplayMode;
                const timeDisplayMode: 'user' | 'machine' | 'site' =
                  rawTdm === 'user' || rawTdm === 'site' ? rawTdm : 'machine';
                const newPrefs: UserPreferences = {
                  temperatureUnit: preferences.temperatureUnit || 'C',
                  timezone: preferences.timezone || getBrowserTimezone(),
                  timeFormat: preferences.timeFormat || '12h',
                  timeDisplayMode,
                  healthAlerts: preferences.healthAlerts !== false, // Default: true
                  processAlerts: preferences.processAlerts !== false, // Default: true
                  thresholdAlerts: preferences.thresholdAlerts !== false, // Default: true
                  cortexAlerts: preferences.cortexAlerts !== false, // Default: true
                  displayAlerts: preferences.displayAlerts !== false, // Default: true
                  talonAlerts: preferences.talonAlerts !== false, // Default: true
                  apiKeyAlerts: preferences.apiKeyAlerts !== false, // Default: true
                  displayAlertsBannerDismissed: preferences.displayAlertsBannerDismissed === true, // Default: false (banner shows)
                  mutedMachines: preferences.mutedMachines || [], // Default: []
                  alertCcEmails: preferences.alertCcEmails || [], // Default: []
                  statsExpanded: preferences.statsExpanded ?? true, // Default: expanded
                  processesExpanded: preferences.processesExpanded ?? true, // Default: expanded
                  displaysExpanded: preferences.displaysExpanded ?? true, // Default: expanded
                  graphTabs: preferences.graphTabs || undefined,
                  activeGraphPanel: preferences.activeGraphPanel || null,
                  graphTimeRange: preferences.graphTimeRange || undefined,
                };
                setUserPreferences(prev => {
                  // Keep prev's reference for unchanged fields — identity churn
                  // re-fires MetricsDetailPanel's reconciliation effect and
                  // reverts unrelated state.
                  const graphTabsEqual = isDeepEqual(prev.graphTabs ?? null, newPrefs.graphTabs ?? null);
                  const activeGraphPanelEqual = isDeepEqual(prev.activeGraphPanel ?? null, newPrefs.activeGraphPanel ?? null);
                  const mutedEqual = arraysEqual(prev.mutedMachines, newPrefs.mutedMachines);
                  const ccEqual = arraysEqual(prev.alertCcEmails, newPrefs.alertCcEmails);

                  // EVERY preference field must be compared here: one left out is
                  // treated as unchanged forever, so a change made in another tab
                  // or device never reaches this one (displayAlerts and the banner
                  // dismissal were both missing).
                  const allEqual =
                    prev.temperatureUnit === newPrefs.temperatureUnit &&
                    prev.timezone === newPrefs.timezone &&
                    prev.timeFormat === newPrefs.timeFormat &&
                    prev.timeDisplayMode === newPrefs.timeDisplayMode &&
                    prev.healthAlerts === newPrefs.healthAlerts &&
                    prev.processAlerts === newPrefs.processAlerts &&
                    prev.thresholdAlerts === newPrefs.thresholdAlerts &&
                    prev.cortexAlerts === newPrefs.cortexAlerts &&
                    prev.displayAlerts === newPrefs.displayAlerts &&
                    prev.talonAlerts === newPrefs.talonAlerts &&
                    prev.apiKeyAlerts === newPrefs.apiKeyAlerts &&
                    prev.displayAlertsBannerDismissed === newPrefs.displayAlertsBannerDismissed &&
                    prev.statsExpanded === newPrefs.statsExpanded &&
                    prev.processesExpanded === newPrefs.processesExpanded &&
                    prev.displaysExpanded === newPrefs.displaysExpanded &&
                    mutedEqual && ccEqual && graphTabsEqual && activeGraphPanelEqual &&
                    prev.graphTimeRange === newPrefs.graphTimeRange;
                  if (allEqual) return prev;

                  // Something changed: rebuild, keeping refs for unchanged fields.
                  return {
                    ...newPrefs,
                    graphTabs: graphTabsEqual ? prev.graphTabs : newPrefs.graphTabs,
                    activeGraphPanel: activeGraphPanelEqual ? prev.activeGraphPanel : newPrefs.activeGraphPanel,
                    mutedMachines: mutedEqual ? prev.mutedMachines : newPrefs.mutedMachines,
                    alertCcEmails: ccEqual ? prev.alertCcEmails : newPrefs.alertCcEmails,
                  };
                });

                setUserDocUid(user.uid);
                setLoading(false);
              } else {
                if (!(await shouldListenerBootstrap(signUpBootstrapRef.current))) {
                  // signUp's own bootstrap created the doc; leave loading true
                  // and let the listener fire again with it.
                  return;
                }
                console.log('⚠️ User document missing, creating now...');
                try {
                  const displayName = user.displayName || '';
                  const bootstrap = await bootstrapUserDocument(user, displayName);
                  console.log('✅ User document created by listener');

                  if (!bootstrap.alreadyExists) {
                    sendUserCreatedNotification(
                      user.email || '',
                      displayName,
                      'google'
                    );
                  }

                  // Leave loading true — the listener fires again with the new doc.
                } catch (bootstrapError: unknown) {
                  const err = bootstrapError as { message?: string } | null;
                  console.error('listener failed to bootstrap document:', bootstrapError);
                  console.error('Error message:', err?.message);
                  setRole(null);
                  setLegacySites([]);
                  setUserDocUid(user.uid);
                  setLoading(false);
                }
              }
            },
            (error) => {
              console.error('Error listening to user document:', error);
              setRole(null);
              setLegacySites([]);
              setUserDocUid(user.uid);
              setLoading(false);
            }
          );
        } else {
          setRole(null);
          setLegacySites([]);
          setUserDocUid(user.uid);
          setLoading(false);
        }
      } else {
        const involuntary = hadUserRef.current && !intentionalSignOutRef.current;
        hadUserRef.current = false;
        intentionalSignOutRef.current = false;
        destroySessionCookie();
        setRole(null);
        setLegacySites([]);
        setUserDocUid(null);
        setLoading(false);
        if (involuntary) {
          toast.error('Session Expired', {
            description: 'You were signed out. Please sign in again.',
          });
        }
      }
    });

    return () => {
      unsubscribe();
      if (userDocUnsubscribe) {
        userDocUnsubscribe();
      }
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string, firstName?: string, lastName?: string, turnstileToken?: string) => {
    try {
      if (!auth || !db) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      const userCredential = await createUserWithEmailAndPassword(auth, email, password);

      if (firstName || lastName) {
        const displayName = [firstName, lastName].filter(Boolean).join(' ');
        await updateProfile(userCredential.user, { displayName });
      }

      // Bootstrap the user document server-side immediately. Published on the ref
      // before the first await, because the doc listener is already live and
      // sees the doc missing — and only this call carries the Turnstile token.
      try {
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || '';
        const pending = bootstrapUserDocument(userCredential.user, displayName, turnstileToken);
        signUpBootstrapRef.current = pending;
        const bootstrap = await pending;
        console.log('✅ User document created in Firestore:', userCredential.user.uid);

        if (!bootstrap.alreadyExists) {
          sendUserCreatedNotification(
            userCredential.user.email || '',
            displayName,
            'email'
          );
        }
      } catch (bootstrapError: unknown) {
        const err = bootstrapError as { message?: string } | null;
        console.error('failed to bootstrap user document:', bootstrapError);
        console.error('Error message:', err?.message);
        // Don't throw: the onAuthStateChanged listener retries the bootstrap.
      } finally {
        signUpBootstrapRef.current = null;
      }

      toast.success('Account Created', {
        description: 'Your account has been created successfully. You can now sign in.',
      });
    } catch (error: unknown) {
      // /register renders inline remediation for this, so no toast — but still
      // report it: OWLETTE-WEB-46 is how we learned real users hit it.
      if ((error as { code?: unknown } | null)?.code === 'auth/email-already-in-use') {
        logError(error, 'signup-email-already-in-use');
        throw error;
      }

      const friendlyMessage = handleError(error);
      toast.error('Sign Up Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      const provider = new GoogleAuthProvider();
      const credential = await signInWithPopup(auth, provider);
      // `additionalUserInfo` is absent on some replayed credentials; default to
      // returning user — a generic greeting beats claiming a signup that wasn't.
      return { isNewUser: getAdditionalUserInfo(credential)?.isNewUser ?? false };
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      // User dismissed the popup. Not a failure — no toast, no report.
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        throw error;
      }

      // No popup possible — almost always an in-app browser, unrescuable by any
      // Firebase config or redirect fallback (see lib/inAppBrowser). No toast:
      // /login and /register render inline remediation. Still reported, with
      // the raw UA — Sentry's parsed browser family collapses every
      // unrecognised iOS webview to one label that doesn't name the host app.
      if (isPopupUnavailableError(error)) {
        logError(error, 'google-signin-popup-blocked', inAppDiagnostics());
        throw error;
      }

      const friendlyMessage = handleError(error);
      toast.error('Google Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly.',
        });
        throw error;
      }

      intentionalSignOutRef.current = true;
      await firebaseSignOut(auth);
      await destroySessionCookie();
      toast.success('Signed Out', {
        description: 'You have been signed out successfully.',
      });
    } catch (error: unknown) {
      // Leave the flag armed only for a sign-out that actually happened.
      intentionalSignOutRef.current = false;
      const friendlyMessage = handleError(error);
      toast.error('Sign Out Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const updateUserProfile = useCallback(async (firstName: string, lastName: string) => {
    try {
      if (!auth?.currentUser) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your profile.',
        });
        throw error;
      }

      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();

      if (!displayName) {
        const error = new Error('Please provide at least a first or last name.');
        toast.error('Update Failed', {
          description: 'Please provide at least a first or last name.',
        });
        throw error;
      }

      await updateProfile(auth.currentUser, { displayName });

      // Spreading a null `currentUser` would yield a truthy `{}` that every
      // `!user` guard waves through.
      setUser(auth.currentUser ? { ...auth.currentUser } : null);

      toast.success('Profile Updated', {
        description: 'Your profile has been updated successfully.',
      });
    } catch (error: unknown) {
      // Session ended mid-update — the listener already told the user; not a defect.
      if (isSessionEndedError(error)) {
        throw error;
      }
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  }, []);

  const updateUserPhoto = useCallback(async (photoBlob: Blob | null) => {
    try {
      if (!auth?.currentUser) {
        throw new Error('No user is currently signed in.');
      }
      if (!storage) {
        throw new Error('Storage is not initialized.');
      }

      const uid = auth.currentUser.uid;
      const avatarRef = storageRef(storage, `users/${uid}/avatar.jpg`);

      if (photoBlob) {
        await uploadBytes(avatarRef, photoBlob, { contentType: 'image/jpeg' });
        const downloadUrl = await getDownloadURL(avatarRef);
        await updateProfile(auth.currentUser, { photoURL: downloadUrl });
      } else {
        try {
          await deleteObject(avatarRef);
        } catch (err: unknown) {
          // Object may not exist — re-throw only unexpected errors.
          const code = (err as { code?: string } | null)?.code;
          if (code !== 'storage/object-not-found') {
            throw err;
          }
        }
        await updateProfile(auth.currentUser, { photoURL: '' });
      }

      setUser(auth.currentUser ? { ...auth.currentUser } : null);

      toast.success(photoBlob ? 'Photo Updated' : 'Photo Removed', {
        description: photoBlob
          ? 'Your profile photo has been updated.'
          : 'Your profile photo has been removed.',
      });
    } catch (error: unknown) {
      // Session ended mid-upload — see updateUserProfile. Blaming the photo
      // made this surface as an unexplained failure in Sentry.
      if (isSessionEndedError(error)) {
        throw error;
      }
      const friendlyMessage = handleError(error);
      toast.error('Photo Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  }, []);

  const updateUserPreferences = useCallback(async (preferences: Partial<UserPreferences>, options?: { silent?: boolean }) => {
    try {
      if (!auth?.currentUser || !db) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your preferences.',
        });
        throw error;
      }

      const userDocRef = doc(db, 'users', auth.currentUser.uid);

      // Read via ref so rapid stacked updates don't clobber each other.
      const current = userPreferencesRef.current;
      const merged = { ...current, ...preferences };

      // Firestore rejects undefined values outright, and never-set optional
      // fields (e.g. activeGraphPanel) sit in `current` as undefined.
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) sanitized[key] = value;
      }

      await setDoc(userDocRef, { preferences: sanitized }, { merge: true });

      // Functional setter so concurrent writes (e.g. the snapshot listener) compose.
      setUserPreferences((prev) => ({ ...prev, ...preferences }));

      if (!options?.silent) {
        toast.success('Preferences Updated', {
          description: 'Your preferences have been saved successfully.',
        });
      }
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  }, []);

  const updateLastSite = useCallback((siteId: string) => {
    setLastSiteId(siteId);
    // localStorage is the fast same-browser read; Firestore is the source of
    // truth, written fire-and-forget for responsiveness.
    localStorage.setItem('owlette_current_site', siteId);
    if (auth?.currentUser && db) {
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      setDoc(userDocRef, { lastSiteId: siteId }, { merge: true }).catch((err) =>
        console.error('Failed to save lastSiteId:', err)
      );
    }
  }, []);

  // The selection is the site sentinel, one machine id, or an explicit set.
  // Same writer, same field, same rules allowlist entry as the single-id form.
  const updateLastMachine = useCallback((siteId: string, selection: LastMachineSelection) => {
    setLastMachineIds((prev) => ({ ...prev, [siteId]: selection }));
    if (auth?.currentUser && db) {
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      setDoc(userDocRef, { lastMachineIds: { [siteId]: selection } }, { merge: true }).catch((err) =>
        console.error('Failed to save lastMachineId:', err)
      );
    }
  }, []);

  const updatePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    try {
      if (!auth?.currentUser) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your password.',
        });
        throw error;
      }

      if (!auth.currentUser.email) {
        const error = new Error('Cannot update password for accounts without email.');
        toast.error('Update Failed', {
          description: 'Password updates are only available for email/password accounts.',
        });
        throw error;
      }

      const credential = EmailAuthProvider.credential(
        auth.currentUser.email,
        currentPassword
      );

      await reauthenticateWithCredential(auth.currentUser, credential);

      await firebaseUpdatePassword(auth.currentUser, newPassword);

      toast.success('Password Updated', {
        description: 'Your password has been updated successfully.',
      });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        toast.error('Update Failed', {
          description: 'Current password is incorrect.',
        });
      } else if (code === 'auth/weak-password') {
        toast.error('Update Failed', {
          description: 'New password is too weak. Please choose a stronger password.',
        });
      } else {
        const friendlyMessage = handleError(error);
        toast.error('Update Failed', {
          description: friendlyMessage,
        });
      }
      throw error;
    }
  }, []);

  const sendPasswordReset = useCallback(async (email: string, turnstileToken?: string) => {
    // Our endpoint (branded Resend email via Admin SDK), not Firebase's plain
    // template. Enumeration-safe: 200 whether or not the account exists, so
    // success is silent and /forgot-password renders the generic confirmation.
    let res: Response;
    try {
      res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          ...(turnstileToken ? { 'cf-turnstile-response': turnstileToken } : {}),
        }),
      });
    } catch (error) {
      toast.error('Reset Failed', {
        description: 'Network error — please check your connection and try again.',
      });
      throw error;
    }

    if (!res.ok) {
      if (res.status === 429) {
        toast.error('Too Many Requests', {
          description: 'Too many attempts. Please wait a few minutes and try again.',
        });
      } else if (res.status === 403) {
        toast.error('Verification Failed', {
          description: 'Please complete the verification challenge and try again.',
        });
      } else if (res.status === 400) {
        toast.error('Invalid Email', {
          description: 'Please enter a valid email address.',
        });
      } else {
        toast.error('Reset Failed', {
          description: 'Could not send the reset email. Please try again.',
        });
      }
      throw new Error(`forgot-password failed (${res.status})`);
    }
  }, []);

  const deleteAccount = useCallback(async (password: string) => {
    try {
      if (!auth?.currentUser || !db) {
        const error = new Error('No user is currently signed in.');
        toast.error('Deletion Failed', {
          description: 'You must be signed in to delete your account.',
        });
        throw error;
      }

      const userId = auth.currentUser.uid;

      if (auth.currentUser.email) {
        const credential = EmailAuthProvider.credential(
          auth.currentUser.email,
          password
        );
        await reauthenticateWithCredential(auth.currentUser, credential);
      }

      // The server revokes tokens and deletes the Auth record, so the SDK signs
      // this session out on its own — intended, not a session dying on us.
      intentionalSignOutRef.current = true;
      const response = await fetch('/api/users/me', {
        method: 'DELETE',
        headers: { 'idempotency-key': `account-delete-${userId}` },
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to delete account data'));
      }

      // No client-side auth.deleteUser(): deleteOwnAccount.server.ts already
      // revoked tokens and deleted the Auth record before this response.
      await destroySessionCookie();

      toast.success('Account Deleted', {
        description: 'Your account has been permanently deleted.',
      });
    } catch (error: unknown) {
      // The account survived, so a later sign-out is not this one.
      intentionalSignOutRef.current = false;
      const code = (error as { code?: string } | null)?.code;
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        toast.error('Deletion Failed', {
          description: 'Password is incorrect.',
        });
      } else if (code === 'auth/requires-recent-login') {
        toast.error('Deletion Failed', {
          description: 'Please sign out and sign in again before deleting your account.',
        });
      } else {
        const friendlyMessage = handleError(error);
        toast.error('Deletion Failed', {
          description: friendlyMessage,
        });
      }
      throw error;
    }
  }, []);

  // Per-site membership — THE source of site access from here on. One
  // collectionGroup listener replaces reading `users/{uid}.sites[]`.
  const { roleMap, loading: membershipLoading, error: membershipError } = useSiteMemberships(user?.uid);

  // A listener that is not running degrades every user to the legacy array. The
  // union hides that today, so without this it stays silent right up until wave
  // 6.1 strips the field and it becomes total.
  useEffect(() => {
    if (!user?.uid || !membershipError) return;
    emitMembershipListenerError(user.uid, membershipError);
  }, [user?.uid, membershipError]);

  // `userSites` is now a PROJECTION, not a second source of truth. The legacy
  // array is unioned in for exactly one release so a user whose backfill has not
  // landed keeps working; wave 6.1 drops the union and the projection together.
  //
  // Withheld until BOTH inputs have delivered for this uid. The two listeners
  // race, and publishing whichever half landed first is not a smaller answer,
  // it is a wrong one: membership-first hands a superadmin (role still null) a
  // member's handful of sites, and the dashboard latched `sites[0]` of that
  // instead of `lastSiteId`. Doc-first counts every legacy site as a fallback.
  const accessResolved = user != null && userDocUid === user.uid && !membershipLoading;
  const { sites: userSites, fallbacks } = useMemo(
    () => (accessResolved ? unionMembership(roleMap, legacySites) : UNRESOLVED_MEMBERSHIP),
    [accessResolved, roleMap, legacySites]
  );

  // Every site the legacy array grants and membership does not. This counter
  // holding at zero is what gates wave 6.1 — not a human reading a dry-run.
  //
  // SUPERADMINS ARE EXCLUDED, and the counter is unusable without that. They hold
  // no member rows by design — the backfill deliberately drops their non-owner
  // `sites[]` entries because they reach every site by global role — so every
  // stale entry a superadmin carries would report as drift forever and pin the
  // gate above zero permanently. For them a missing membership is the intended
  // state, not a gap. `useSites` never reads their `userSites` either; it takes
  // the superadmin branch and lists every site.
  useEffect(() => {
    if (!user?.uid || role === 'superadmin' || fallbacks.length === 0) return;
    emitMembershipFallback(user.uid, fallbacks);
  }, [user?.uid, role, fallbacks]);

  const isSuperadmin = computeIsSuperadmin(role);
  const isSiteAdmin = useCallback(
    (siteId: string) => computeIsSiteAdmin(role, roleMap, siteId),
    [role, roleMap]
  );
  const administersAnySite = useMemo(
    () => computeAdministersAnySite(role, roleMap),
    [role, roleMap]
  );
  const isSiteOwner = useCallback(
    (siteId: string) => computeIsSiteOwner(role, roleMap, siteId),
    [role, roleMap]
  );

  const value = useMemo(() => ({
    user,
    loading,
    role,
    isSuperadmin,
    isSiteAdmin,
    administersAnySite,
    isSiteOwner,
    userSites,
    lastSiteId,
    lastMachineIds,
    requiresMfaSetup,
    mfaFactors,
    userPreferences,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    updateUserProfile,
    updateUserPhoto,
    updatePassword,
    sendPasswordReset,
    updateUserPreferences,
    updateLastSite,
    updateLastMachine,
    deleteAccount,
  }), [user, loading, role, isSuperadmin, isSiteAdmin, administersAnySite, isSiteOwner, userSites, lastSiteId, lastMachineIds, requiresMfaSetup, mfaFactors, userPreferences, signIn, signUp, signInWithGoogle, signOut, updateUserProfile, updateUserPhoto, updatePassword, sendPasswordReset, updateUserPreferences, updateLastSite, updateLastMachine, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
