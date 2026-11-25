# A fix to fleet behaviour ships its upgrade-path half in the installer

During a self-update the old service and the old desktop app are what run on the machine, and the installer is the only new code that executes there. So a fix that lives only in the new build does nothing for the upgrade that delivers it, which is how the UAC prompt in ADR 0005 reached the fleet a second time. Any fix to behaviour machines exhibit while updating carries an installer-side part, and is proven by upgrading from the oldest fielded version, never from a dev build.

## Consequences

- Upgrade tests start from the fleet floor, not from a clean install. `scripts/vm/18b-verify-upgrade.ps1` installs each fielded version on a VM and lays the candidate over it.
- The same rule applies to data old agents read: the legacy `installer_metadata/cortex_cli` pin is kept current until the fleet floor reaches 3.4, because every agent before 3.4 reads only that id.
