"""Let the operator start and stop OwletteService without a UAC prompt.

The desktop app runs unelevated in the console session. Windows' default service
DACL gives INTERACTIVE (`S-1-5-4`) read rights only::

    D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)
      (A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)
      (A;;CCLCSWLOCRRC;;;IU)          <- no RP (start), no WP (stop)
      (A;;CCLCSWLOCRRC;;;SU)

so `OpenService(SERVICE_START)` and `OpenService(SERVICE_STOP)` both fail with
ERROR_ACCESS_DENIED, and `desktop/src-tauri/src/service_ctl.rs` falls back to a
`runas` shell running `net start` / `net stop`. That is the "Windows Command
Processor" prompt operators see on every quit and every launch. Adding `RP|WP`
to the ACE that is already there removes it.

An ACE for BUILTIN\\Administrators would not help: the app runs under a
UAC-filtered token, where the Administrators SID is present but deny-only.

What is deliberately NOT granted: `DC` (SERVICE_CHANGE_CONFIG), `WD`, `WO` and
`SD`. `DC` is the binPath-rewrite escalation — the whole reason to merge two bits
rather than hand out SERVICE_ALL_ACCESS. It also means "exit owlette" cannot
outlive a reboot, since disabling the service is a config change; the tray's
confirmation says so.

The grant lives here rather than in the Rust host because pywin32 is already a
dependency and `agent/host` is deliberately single-dependency (see its
Cargo.toml). Running from the agent has a second benefit: `registration.install`
deletes and recreates the service on every upgrade, which discards any DACL set
out of band, and the agent re-applies this on its next start without needing a
separate backfill.

Opting out: set `HKLM\\SOFTWARE\\Owlette\\AllowLocalServiceControl` to 0 (the
installer writes it from the `/NOSERVICECONTROL` task). That key is under
HKLM\\SOFTWARE, which standard users cannot write — unlike `config.json`, which
lives in a users-modify tree. Removing the ACE by hand is not a way to opt out:
this runs on every agent start and would put it back.
"""

import logging
import winreg

import win32security

import shared_utils

# `IU` — every interactive logon on this machine, and only those. `BU`
# (BUILTIN\\Users) and `AU` (Authenticated Users) both appear in batch, service
# and network logon tokens, and on a domain-joined machine `AU` matches every
# domain user and computer account in the forest.
INTERACTIVE_SID = 'S-1-5-4'

# winsvc.h. Not in win32security, and worth spelling out next to what they cost.
SERVICE_START = 0x0010
SERVICE_STOP = 0x0020
GRANTED_RIGHTS = SERVICE_START | SERVICE_STOP

# Where the opt-out lives. Standard users cannot write under HKLM\\SOFTWARE.
POLICY_KEY = r'SOFTWARE\Owlette'
POLICY_VALUE = 'AllowLocalServiceControl'

# One attempt per process, however many times the caller asks.
_applied = None


def ensure_interactive_control():
    """Apply the grant once per process. Never raises; returns True if in place.

    Non-fatal by design: a machine that keeps the UAC prompt still works, it is
    just the older experience. Mirrors `registration::ensure_preshutdown_timeout`
    in the host.
    """
    global _applied
    if _applied is None:
        try:
            _applied = _apply()
        except Exception as e:
            logging.warning(
                f"Could not grant interactive service control: {e} - "
                "start/stop from the desktop app will keep prompting for admin"
            )
            _applied = False
    return _applied


def _control_allowed():
    """False only when an administrator has explicitly turned this off."""
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY) as key:
            value, _ = winreg.QueryValueEx(key, POLICY_VALUE)
            return int(value) != 0
    except FileNotFoundError:
        # Neither the key nor the value exists: the default, which is on.
        return True
    except (OSError, ValueError, TypeError) as e:
        # A malformed value is not consent to widen anything.
        logging.warning(f"Could not read {POLICY_VALUE}, leaving service rights alone: {e}")
        return False


def _apply():
    if not _control_allowed():
        logging.info(
            f"{POLICY_VALUE} is 0 - leaving the service DACL alone; "
            "the desktop app will prompt for admin to start or stop the service"
        )
        return False

    interactive = win32security.ConvertStringSidToSid(INTERACTIVE_SID)
    descriptor = win32security.GetNamedSecurityInfo(
        shared_utils.SERVICE_NAME,
        win32security.SE_SERVICE,
        win32security.DACL_SECURITY_INFORMATION,
    )
    dacl = descriptor.GetSecurityDescriptorDacl()
    if dacl is None:
        # A NULL DACL grants everyone everything. Replacing it with an explicit
        # one here would be a security change well beyond this module's remit.
        logging.warning(
            f"{shared_utils.SERVICE_NAME} has a NULL DACL - not touching it"
        )
        return False

    if _denies_interactive(dacl, interactive):
        # An explicit deny outranks any allow we could add, whatever the ACE
        # order. Reporting success here would be a lie.
        logging.info(
            f"{shared_utils.SERVICE_NAME} denies interactive start/stop by policy - "
            "leaving it alone"
        )
        return False

    merged, changed = _with_interactive_rights(dacl, interactive)
    if not changed:
        logging.debug("Interactive service control is already granted")
        return True

    win32security.SetNamedSecurityInfo(
        shared_utils.SERVICE_NAME,
        win32security.SE_SERVICE,
        win32security.DACL_SECURITY_INFORMATION,
        None,
        None,
        merged,
        None,
    )
    logging.info(
        f"Granted interactive users start/stop on {shared_utils.SERVICE_NAME} - "
        "the desktop app no longer needs an admin prompt"
    )
    return True


def _denies_interactive(dacl, interactive):
    """True when a DENY ACE would defeat the grant."""
    for index in range(dacl.GetAceCount()):
        (ace_type, _flags), mask, sid = dacl.GetAce(index)
        if ace_type != win32security.ACCESS_DENIED_ACE_TYPE:
            continue
        if sid == interactive and mask & GRANTED_RIGHTS:
            return True
    return False


def _with_interactive_rights(dacl, interactive):
    """Return `(dacl, changed)` with start/stop added for `interactive`.

    Rebuilt rather than edited because pywin32's ACL exposes no mask setter. Each
    ACE is copied in its original position with its flags intact, so canonical
    ordering (denies before allows) survives; only the interactive ACE's mask
    changes. When there is no interactive ACE at all, one is appended — after
    every existing ACE, which keeps the ordering valid because [`_denies_interactive`]
    has already established that no deny can be in play.
    """
    merged = win32security.ACL()
    changed = False
    found = False

    for index in range(dacl.GetAceCount()):
        (ace_type, flags), mask, sid = dacl.GetAce(index)
        if ace_type == win32security.ACCESS_ALLOWED_ACE_TYPE and sid == interactive:
            found = True
            if mask & GRANTED_RIGHTS != GRANTED_RIGHTS:
                # Keep everything the ACE already carries: CC|LC|SW|LO|CR|RC are
                # what let the app read the service state without elevation, and
                # dropping them would blank the status footer.
                mask |= GRANTED_RIGHTS
                changed = True
        _copy_ace(merged, ace_type, flags, mask, sid)

    if not found:
        merged.AddAccessAllowedAceEx(
            win32security.ACL_REVISION, 0, GRANTED_RIGHTS, interactive
        )
        changed = True

    return merged, changed


def _copy_ace(acl, ace_type, flags, mask, sid):
    """Append one ACE. Service DACLs only ever hold allow and deny ACEs."""
    if ace_type == win32security.ACCESS_ALLOWED_ACE_TYPE:
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, mask, sid)
    elif ace_type == win32security.ACCESS_DENIED_ACE_TYPE:
        acl.AddAccessDeniedAceEx(win32security.ACL_REVISION, flags, mask, sid)
    else:
        # Nothing else is expected here, and silently dropping an ACE would
        # quietly widen or narrow the descriptor.
        raise ValueError(f"unexpected ACE type {ace_type} in the service DACL")
