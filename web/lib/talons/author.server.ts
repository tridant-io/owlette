/**
 * Fire-time re-resolution of a talon's AUTHOR — the person an unattended run
 * acts as and whose llm key it spends. BYOK is one key in one place
 * (`users/{uid}/settings/llm`), so there is no site-shared key to fall back
 * to; `createdBy` names whose key a 3am talon spends.
 *
 * Access is re-resolved on EVERY run — never trusted from authoring time.
 *
 * Every {@link TalonAuthorError} is UNRECOVERABLE: the next firing fails
 * identically, so the engine disables the talon on the spot. That is why
 * `verifyUserSiteAccess` throws a typed `SiteAccessError` — a Firestore outage
 * surfaces as a different class and escapes this module un-narrowed, so an
 * unreachable database can never disable a talon.
 *
 * Server-side only — never import this in client components.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SiteAccessError,
  assertLlmKeyAvailable,
  resolveLlmConfig,
  verifyUserSiteAccess,
  type SiteAccessLevel,
} from '@/lib/hoot-utils.server';
import type { LlmConfig } from '@/lib/llm';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason } from './types';

/**
 * `createdBy` prefix for a non-user author (`authorIdentifier` in
 * `store.server.ts`) — no uid to re-resolve, no key to spend.
 */
const SYSTEM_AUTHOR_PREFIX = 'system:';

/**
 * Unfixable-by-retry author problem. `reason` is stamped on the talon and its
 * run; `message` is the log diagnostic.
 */
export class TalonAuthorError extends Error {
  readonly reason: TalonDisabledReason;

  constructor(reason: TalonDisabledReason, message: string) {
    super(message);
    this.name = 'TalonAuthorError';
    this.reason = reason;
  }
}

/** The author, resolved: their uid and the access level they hold RIGHT NOW. */
export interface TalonAuthor {
  userId: string;
  access: SiteAccessLevel;
}

/**
 * Site-access refusal → disable reason. `site_not_found` is deliberately
 * absent: not the author's fault, so it falls through as a plain failure.
 */
const REASON_BY_ACCESS_CODE: Readonly<Partial<Record<string, TalonDisabledReason>>> = {
  user_not_found: 'creator_deleted',
  user_deleted: 'creator_deleted',
  no_site_access: 'creator_access_revoked',
};

/**
 * Re-resolve the talon's author and their current site access.
 * Throws {@link TalonAuthorError} when the author can never back this talon
 * again; anything transient escapes unchanged and must NOT disable the talon.
 */
export async function resolveTalonAuthor(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
): Promise<TalonAuthor> {
  const userId = talon.createdBy;
  if (!userId || userId.startsWith(SYSTEM_AUTHOR_PREFIX)) {
    throw new TalonAuthorError(
      'creator_not_a_user',
      `Talon ${talon.id} has no user author, so no access or llm key can be resolved for it.`,
    );
  }

  let access: SiteAccessLevel;
  try {
    access = await verifyUserSiteAccess(db, userId, siteId);
  } catch (error) {
    if (error instanceof SiteAccessError) {
      const reason = REASON_BY_ACCESS_CODE[error.code];
      if (reason) {
        throw new TalonAuthorError(
          reason,
          `Talon ${talon.id} author ${userId} can no longer run it: ${error.message}`,
        );
      }
    }
    throw error;
  }

  // a scoped author stops the talon, as a removed one does: a talon spans the
  // site, its hoot output lists every machine (hootOutput.server.ts passes a
  // whole-site scope), and TALON_MANAGE is site-wide. reassigning re-arms it.
  if (access.standing.machineIds !== null) {
    throw new TalonAuthorError(
      'creator_access_revoked',
      `Talon ${talon.id} author ${userId} is limited to some machines; a talon needs whole-site standing.`,
    );
  }
  return { userId, access };
}

/**
 * The author's llm config, for a caller that needs the model itself. Throws
 * `creator_missing_llm_key` when no usable key is saved — including the
 * un-decryptable case, equally un-runnable until a human re-saves it.
 */
export async function resolveTalonAuthorLlmConfig(
  db: Firestore,
  userId: string,
): Promise<LlmConfig> {
  try {
    return await resolveLlmConfig(db, userId);
  } catch (error) {
    throw missingKeyError(userId, error);
  }
}

/**
 * The same precondition WITHOUT the key, for the hoot-turn pre-flight: it must
 * know the key exists but never hold it — the runner resolves its own.
 * Throws `creator_missing_llm_key`.
 */
export async function assertTalonAuthorLlmKey(
  db: Firestore,
  userId: string,
): Promise<void> {
  try {
    await assertLlmKeyAvailable(db, userId);
  } catch (error) {
    throw missingKeyError(userId, error);
  }
}

function missingKeyError(userId: string, error: unknown): TalonAuthorError {
  return new TalonAuthorError(
    'creator_missing_llm_key',
    `Talon author ${userId} has no usable llm key: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
