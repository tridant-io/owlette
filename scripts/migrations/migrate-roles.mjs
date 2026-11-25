#!/usr/bin/env node
/**
 * Status: retired 2026-09-06 and refuses to run. It was step 2.2 of the 2.12.x
 * promotion (docs/runbooks/upgrade-2.12.0.md): it renamed the global role
 * 'user' to 'member' and 'admin' to 'superadmin'.
 * migrate-global-role-values.mjs superseded it: global roles are now
 * `user | superadmin`, so a rerun would turn every `user` back into the retired
 * `member` and make any leftover global `admin` a platform-wide superadmin.
 * The migration itself is in git history (`git log -- scripts/migrations/migrate-roles.mjs`).
 */

console.error(
  'migrate-roles.mjs is retired and refuses to run. migrate-global-role-values.mjs superseded it on ' +
    '2026-09-06: global roles are now user|superadmin, and this script would rewrite every user to the ' +
    'retired member role and make any global admin a superadmin.'
);
process.exit(1);
