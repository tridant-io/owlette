"""
Installer utilities for downloading and executing software installers.
"""

import os
import logging
import subprocess
import tempfile
import requests
import psutil
import hashlib
import time
from typing import Optional, Callable, Dict, List


def hide_registry_keys(software_name: str) -> List[dict]:
    """Temporarily hide a product's uninstall registry keys.

    Some installers (TouchDesigner) detect prior installs via these keys and
    force-uninstall them in silent mode. Renaming the keys makes the installer
    see no previous version, enabling side-by-side installation.

    ``software_name`` is a DisplayName prefix. Returns
    ``[{'original', 'hidden'}, ...]`` for restore_registry_keys().
    """
    import winreg

    uninstall_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    hidden_keys = []

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, uninstall_path) as parent:
            index = 0
            keys_to_hide = []
            while True:
                try:
                    subkey_name = winreg.EnumKey(parent, index)
                    index += 1
                except OSError:
                    break

                try:
                    with winreg.OpenKey(parent, subkey_name) as subkey:
                        display_name, _ = winreg.QueryValueEx(subkey, "DisplayName")
                        if display_name and display_name.strip().startswith(software_name):
                            keys_to_hide.append(subkey_name)
                except (OSError, FileNotFoundError):
                    continue

        # reg.exe, because winreg has no rename API.
        for key_name in keys_to_hide:
            hidden_name = f"_owlette_hidden_{key_name}"
            full_path = f"HKLM\\{uninstall_path}\\{key_name}"
            hidden_path = f"HKLM\\{uninstall_path}\\{hidden_name}"

            result = subprocess.run(
                ['reg', 'copy', full_path, hidden_path, '/s', '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to copy registry key {key_name}: {result.stderr}")
                continue

            result = subprocess.run(
                ['reg', 'delete', full_path, '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to delete original registry key {key_name}: {result.stderr}")
                subprocess.run(['reg', 'delete', hidden_path, '/f'],
                               capture_output=True, text=True, timeout=10)
                continue

            hidden_keys.append({'original': key_name, 'hidden': hidden_name})
            logging.info(f"Hidden registry key: {key_name} -> {hidden_name}")

        if hidden_keys:
            logging.info(f"Hidden {len(hidden_keys)} existing '{software_name}' registry key(s)")
        else:
            logging.debug(f"No existing '{software_name}' registry keys found to hide")

    except Exception as e:
        logging.error(f"Error hiding registry keys for '{software_name}': {e}")

    return hidden_keys


def restore_registry_keys(hidden_keys: List[dict]) -> None:
    """Restore keys hidden by hide_registry_keys() once the install finishes."""
    uninstall_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"

    for entry in hidden_keys:
        original_name = entry['original']
        hidden_name = entry['hidden']
        original_path = f"HKLM\\{uninstall_path}\\{original_name}"
        hidden_path = f"HKLM\\{uninstall_path}\\{hidden_name}"

        try:
            result = subprocess.run(
                ['reg', 'copy', hidden_path, original_path, '/s', '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to restore registry key {original_name}: {result.stderr}")
                continue

            subprocess.run(
                ['reg', 'delete', hidden_path, '/f'],
                capture_output=True, text=True, timeout=10
            )

            logging.info(f"Restored registry key: {hidden_name} -> {original_name}")

        except Exception as e:
            logging.error(f"Error restoring registry key {original_name}: {e}")

    if hidden_keys:
        logging.info(f"Restored {len(hidden_keys)} registry key(s)")


def download_file(
    url: str,
    dest_path: str,
    progress_callback: Optional[Callable[[int], None]] = None,
    max_retries: int = 3,
    connect_timeout: int = 30,
    read_timeout: int = 600,
    strict_path: bool = False,
) -> tuple[bool, str]:
    """Download a URL with progress reporting and retries.

    ``progress_callback`` receives 0-100. Timeouts are in seconds; ``read_timeout``
    defaults high because installers are large.

    Returns ``(success, actual_path)`` — the path can differ from ``dest_path``
    when the destination was locked by another process. With ``strict_path`` a
    locked destination raises PermissionError instead, so a success is always
    ``dest_path`` itself.
    """
    logging.debug(f"Starting download from {url}")

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    if os.path.exists(dest_path):
        logging.debug(f"File already exists at {dest_path}, attempting cleanup...")
        try:
            os.remove(dest_path)
            logging.debug("Existing file removed successfully")
        except PermissionError:
            if strict_path:
                raise
            # Locked by another process — fall back to a unique filename.
            timestamp = int(time.time())
            base_name, ext = os.path.splitext(dest_path)
            dest_path = f"{base_name}_{timestamp}{ext}"
            logging.warning(f"Could not remove existing file (in use), using unique filename: {dest_path}")
        except Exception as e:
            logging.error(f"Error removing existing file: {e}")
            return False, ""

    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            if attempt > 1:
                # 5s, 10s, 20s...
                wait_time = 5 * (2 ** (attempt - 2))
                logging.info(f"Retry attempt {attempt}/{max_retries} after {wait_time}s delay...")
                time.sleep(wait_time)

            # Stream so a multi-GB installer never lands in memory. Separate
            # connect/read timeouts: large files need the longer read window.
            response = requests.get(
                url,
                stream=True,
                timeout=(connect_timeout, read_timeout),
                allow_redirects=True  # Follow redirects (important for Dropbox/cloud storage)
            )
            response.raise_for_status()

            total_size = int(response.headers.get('content-length', 0))
            downloaded_size = 0

            chunk_size = 64 * 1024  # 64KB chunks

            with open(dest_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=chunk_size):
                    if chunk:
                        f.write(chunk)
                        downloaded_size += len(chunk)

                        if total_size > 0 and progress_callback:
                            progress = int((downloaded_size / total_size) * 100)
                            progress_callback(progress)

            if total_size > 0 and downloaded_size < total_size:
                raise requests.exceptions.RequestException(
                    f"Incomplete download: got {downloaded_size} bytes, expected {total_size}"
                )

            logging.info(f"Download completed: {dest_path} ({downloaded_size:,} bytes)")
            return True, dest_path

        except requests.exceptions.Timeout as e:
            last_error = f"Timeout on attempt {attempt}: {e}"
            logging.warning(last_error)
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error on attempt {attempt}: {e}"
            logging.warning(last_error)
        except requests.exceptions.RequestException as e:
            last_error = f"Request error on attempt {attempt}: {e}"
            logging.warning(last_error)
        except Exception as e:
            last_error = f"Unexpected error on attempt {attempt}: {e}"
            logging.warning(last_error)

        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except:
                pass

    logging.error(f"Download failed after {max_retries} attempts. Last error: {last_error}")
    return False, ""


def _kill_process_tree(pid: int) -> None:
    """Kill a process and all its children."""
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)

        for child in children:
            try:
                logging.warning(f"Killing child process: {child.name()} (PID: {child.pid})")
                child.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

        parent.kill()
        logging.warning(f"Killed installer process tree (parent PID: {pid}, {len(children)} children)")

        gone, alive = psutil.wait_procs([parent] + children, timeout=3)
        for proc in alive:
            try:
                proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    except psutil.NoSuchProcess:
        pass
    except Exception as e:
        logging.error(f"Error killing process tree: {e}")


def execute_installer(
    installer_path: str,
    flags: str = "",
    installer_name: str = "",
    active_processes: Optional[Dict[str, int]] = None,
    timeout_seconds: int = 1200,
    user_token=None,
    environment=None,
) -> tuple[bool, int, str]:
    """Execute an installer with silent flags.

    With ``user_token`` runs in the user's desktop session via
    CreateProcessAsUser; without one falls back to subprocess.Popen in Session 0.
    ``active_processes`` maps installer name → pid so a run can be cancelled.

    Returns ``(success, exit_code, error_message)``.
    """
    try:
        if not os.path.exists(installer_path):
            error_msg = f"Installer not found: {installer_path}"
            logging.error(error_msg)
            return False, -1, error_msg

        # A single string — CreateProcess parses args itself.
        command = f'"{installer_path}"'
        if flags:
            command = f'{command} {flags}'

        logging.info(f"Executing installer: {command}")

        if user_token is not None:
            return _execute_as_user(
                command, user_token, environment,
                installer_name, active_processes, timeout_seconds,
            )
        else:
            return _execute_as_system(
                command, installer_name, active_processes, timeout_seconds,
            )

    except Exception as e:
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        error_msg = f"Unexpected error executing installer: {e}"
        logging.error(error_msg)
        return False, -1, error_msg


def _finish_installer_run(
    exit_code: int,
    installer_name: str,
    active_processes: Optional[Dict[str, int]],
    stderr: Optional[str] = None,
) -> tuple[bool, int, str]:
    """Untrack the run and map its exit code to ``(success, exit_code, message)``."""
    if active_processes and installer_name in active_processes:
        del active_processes[installer_name]

    logging.debug(f"Installer exit code: {exit_code}")

    if exit_code == 0:
        return True, exit_code, ""
    elif exit_code == 3010:
        logging.info("Installer returned 3010 (reboot required) — treating as success")
        return True, exit_code, ""
    else:
        error_msg = f"Installer failed with exit code {exit_code}"
        if stderr:
            error_msg += f": {stderr}"
        logging.error(error_msg)
        return False, exit_code, error_msg


def _execute_as_user(
    command: str,
    user_token,
    environment,
    installer_name: str,
    active_processes: Optional[Dict[str, int]],
    timeout_seconds: int,
) -> tuple[bool, int, str]:
    """Run installer in the user's desktop session via CreateProcessAsUser."""
    import win32process
    import win32event
    import win32api
    import win32con

    si = win32process.STARTUPINFO()
    si.dwFlags = win32process.STARTF_USESHOWWINDOW
    # Minimized, NOT hidden: SW_HIDE makes an unexpected installer prompt (e.g.
    # TD's "directory exists" dialog) invisible, and it then blocks forever.
    si.wShowWindow = win32con.SW_SHOWMINNOACTIVE
    si.lpDesktop = "WinSta0\\Default"

    logging.info("Launching installer in user session (CreateProcessAsUser)")

    h_process, h_thread, pid, _tid = win32process.CreateProcessAsUser(
        user_token,
        None,           # Application name
        command,        # Command line
        None, None,     # Security attributes
        0,              # Inherit handles
        win32con.NORMAL_PRIORITY_CLASS,
        environment,
        None,           # Current directory
        si,
    )
    win32api.CloseHandle(h_thread)

    logging.info(f"Installer launched in user session (PID: {pid})")

    if active_processes is not None and installer_name:
        active_processes[installer_name] = pid

    timeout_ms = timeout_seconds * 1000
    result = win32event.WaitForSingleObject(h_process, timeout_ms)

    if result == win32event.WAIT_TIMEOUT:
        logging.error(f"Installer timed out after {timeout_seconds}s (PID: {pid})")
        _kill_process_tree(pid)
        win32api.CloseHandle(h_process)
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        return False, -1, f"Installer execution timeout (exceeded {timeout_seconds} seconds)"

    exit_code = win32process.GetExitCodeProcess(h_process)
    win32api.CloseHandle(h_process)

    return _finish_installer_run(exit_code, installer_name, active_processes)


def _execute_as_system(
    command: str,
    installer_name: str,
    active_processes: Optional[Dict[str, int]],
    timeout_seconds: int,
) -> tuple[bool, int, str]:
    """Run installer in Session 0 via subprocess (fallback when no user session)."""
    process = subprocess.Popen(
        command,
        shell=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    pid = process.pid
    if active_processes is not None and installer_name:
        active_processes[installer_name] = pid
        logging.debug(f"Tracking installer process: {installer_name} (PID: {pid})")

    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
        exit_code = process.returncode
    except subprocess.TimeoutExpired:
        _kill_process_tree(pid)
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        error_msg = f"Installer execution timeout (exceeded {timeout_seconds} seconds)"
        logging.error(error_msg)
        return False, -1, error_msg

    return _finish_installer_run(exit_code, installer_name, active_processes, stderr)


def _checksum_matches(chunks, expected_sha256: str) -> bool:
    """SHA256 of the byte ``chunks`` against ``expected_sha256`` (case-insensitive)."""
    sha256_hash = hashlib.sha256()
    for chunk in chunks:
        sha256_hash.update(chunk)

    actual_hash = sha256_hash.hexdigest().lower()
    expected_hash = expected_sha256.lower()

    if actual_hash == expected_hash:
        logging.debug(f"Checksum verification passed: {actual_hash}")
        return True
    else:
        logging.error("Checksum verification FAILED!")
        logging.error(f"Expected: {expected_hash}")
        logging.error(f"Actual:   {actual_hash}")
        return False


def verify_checksum(file_path: str, expected_sha256: str) -> bool:
    """Verify a file's SHA256 against ``expected_sha256`` (case-insensitive)."""
    try:
        with open(file_path, 'rb') as f:
            return _checksum_matches(iter(lambda: f.read(8192), b''), expected_sha256)
    except Exception as e:
        logging.error(f"Error verifying checksum: {e}")
        return False


# The first bytes of the one installer kind each OS can run, and what to call it
# in a refusal. MACHINE_EXEC_COMMAND is held by the cortex and talon system
# actors as well as by an operator, so without this a correctly-checksummed
# package for another OS is a reachable way to brick a kiosk.
ARTIFACT_MAGIC = {
    'windows': (b'MZ', 'a Windows executable'),
    'macos': (b'xar!', 'a macOS installer package'),
    'linux': (b'!<arch>', 'a Debian package'),
}

# The name the downloaded artifact is given. The extension is part of the
# contract rather than cosmetic: `apt-get install <path>` refuses a package that
# is not called `.deb`, and `installer -pkg` a file that is not called `.pkg`.
UPDATE_ARTIFACT_NAMES = {
    'windows': 'owlette-Update.exe',
    'macos': 'owlette-update.pkg',
    'linux': 'owlette-update.deb',
}

# Every shipped installer is far larger. Anything under this is an error page, a
# redirect body or a truncated download rather than a package.
MIN_ARTIFACT_BYTES = 1_000_000


def verify_artifact_family(file_path: str, os_family: str) -> None:
    """Refuse an update artifact that is not this OS's own installer.

    Raises ``ValueError``; the caller renders it as the command's error. Both
    halves run before anything is executed: a file under ``MIN_ARTIFACT_BYTES``
    never was the object it claims to be, and the magic is what tells a ``.pkg``
    from a ``.deb`` from an ``.exe`` once it was.
    """
    expected = ARTIFACT_MAGIC.get(os_family)
    if expected is None:
        raise ValueError(
            f"No installer format is known for os family '{os_family}' - "
            f"refusing to install the downloaded artifact"
        )
    magic, description = expected

    size = os.path.getsize(file_path)
    if size < MIN_ARTIFACT_BYTES:
        raise ValueError(
            f"Downloaded file too small ({size} bytes) - likely not a valid installer"
        )

    with open(file_path, 'rb') as f:
        header = f.read(len(magic))
    if header != magic:
        raise ValueError(
            f"Downloaded file is not {description} - refusing an artifact that is "
            f"not this machine's own ({os_family})"
        )
def open_verified(file_path: str, expected_sha256: str):
    """Open ``file_path`` sharing read access only, and return the handle when
    the SHA256 read through it matches ``expected_sha256``; otherwise close it
    and return None. The caller owns the handle.

    While it is open no one can write, replace, rename or delete the file, so
    the next process to open the path gets the bytes that were hashed. The
    path's own entry is opened, never a link's target, so the hash and the hold
    cover the same file.
    """
    import pywintypes
    import win32file

    try:
        handle = win32file.CreateFile(
            file_path, win32file.GENERIC_READ, win32file.FILE_SHARE_READ, None,
            win32file.OPEN_EXISTING,
            win32file.FILE_ATTRIBUTE_NORMAL | win32file.FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    except pywintypes.error as e:
        logging.error(f"Error opening {file_path} to verify its checksum: {e}")
        return None
    try:
        chunks = iter(lambda: win32file.ReadFile(handle, 64 * 1024)[1], b'')
        if _checksum_matches(chunks, expected_sha256):
            return handle
    except Exception as e:
        logging.error(f"Error verifying checksum: {e}")
    handle.Close()
    return None


def verify_installation(path: str) -> bool:
    """Verify an install landed, by checking that ``path`` exists."""
    exists = os.path.exists(path)
    if exists:
        logging.info(f"Installation verified: {path} exists")
    else:
        logging.warning(f"Installation verification failed: {path} not found")
    return exists


def get_temp_installer_path(installer_name: str) -> str:
    """Full path under the temp dir for downloading ``installer_name``."""
    temp_dir = tempfile.gettempdir()
    owlette_temp = os.path.join(temp_dir, "owlette_installers")
    os.makedirs(owlette_temp, exist_ok=True)
    return os.path.join(owlette_temp, installer_name)


def cleanup_installer(installer_path: str, force: bool = False) -> bool:
    """Remove a temp installer file.

    ``force`` kills processes holding the file open before retrying the delete.
    """
    try:
        if not os.path.exists(installer_path):
            return False

        try:
            os.remove(installer_path)
            logging.debug(f"Cleaned up installer: {installer_path}")
            return True
        except PermissionError as e:
            if not force:
                logging.warning(f"Failed to cleanup installer {installer_path}: {e}")
                return False

            logging.warning(f"File is locked: {installer_path}, attempting force cleanup...")

            try:
                import psutil

                installer_name = os.path.basename(installer_path)
                killed_processes = []

                for proc in psutil.process_iter(['pid', 'name', 'exe']):
                    try:
                        proc_name = proc.info['name']
                        proc_exe = proc.info['exe']

                        if (proc_name and installer_name.lower() in proc_name.lower()) or \
                           (proc_exe and installer_path.lower() in proc_exe.lower()):
                            logging.warning(f"Killing process using installer: {proc_name} (PID: {proc.info['pid']})")
                            proc.kill()
                            killed_processes.append(proc.info['pid'])
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue

                if killed_processes:
                    import time
                    time.sleep(1)

                    os.remove(installer_path)
                    logging.debug(f"Force cleanup succeeded: {installer_path} (killed {len(killed_processes)} process(es))")
                    return True
                else:
                    logging.warning(f"No processes found using {installer_path}, but file is still locked")
                    return False

            except ImportError:
                logging.error("psutil not available for force cleanup")
                return False
            except Exception as force_error:
                logging.error(f"Force cleanup failed: {force_error}")
                return False

    except Exception as e:
        logging.warning(f"Failed to cleanup installer {installer_path}: {e}")
        return False


def cancel_installation(installer_name: str, active_processes: Dict[str, int]) -> tuple[bool, str]:
    """Cancel an active installation by killing its process tree.

    Returns ``(success, message)``.
    """
    try:
        if installer_name not in active_processes:
            return False, f"No active installation found for {installer_name}"

        pid = active_processes[installer_name]
        logging.debug(f"Cancelling installation: {installer_name} (PID: {pid})")

        _kill_process_tree(pid)

        del active_processes[installer_name]

        installer_path = get_temp_installer_path(installer_name)
        cleanup_installer(installer_path)

        logging.info(f"Installation cancelled successfully: {installer_name}")
        return True, f"Installation cancelled: {installer_name}"

    except Exception as e:
        error_msg = f"Error cancelling installation: {str(e)}"
        logging.error(error_msg)
        return False, error_msg


# The transient unit and the launchd job the update runs as. Named rather than
# spawned: the installer stops the agent, and a child of the daemon dies with it
# — a `systemd-run --collect` unit and a bootstrapped launchd job both outlive
# the process that asked for them.
UPDATE_UNIT_NAME = 'owlette-update'
UPDATE_JOB_LABEL = 'app.owlette.update'
# Where the launchd job's installer writes, under the data root: the job runs
# detached from the agent, and a failed install would otherwise leave no trace.
_MACOS_UPDATE_LOG = 'logs/update_installer.log'

_APT_SIMULATE_TIMEOUT = 120
_UPDATE_HANDOFF_TIMEOUT = 30
_DPKG_CONFIGURE_TIMEOUT = 300

# What apt says when an earlier package operation was interrupted: nothing
# installs at all until `dpkg --configure -a` finishes it.
_DPKG_INTERRUPTED_MARKER = 'dpkg was interrupted'

# The lock every package operation takes, and which the update must wait for.
_DPKG_FRONTEND_LOCK = '/var/lib/dpkg/lock-frontend'


def start_self_update(installer_path: str, os_family: str) -> tuple[bool, str]:
    """Hand the verified package to the OS, outside this process's lifetime.

    Returns ``(True, detail)`` once the installer is running somewhere the
    agent's own shutdown cannot reach, and ``(False, '<code>: ...')`` when the
    installed version keeps running instead — ``update_unsatisfiable`` for a
    package this system cannot resolve, ``update_deferred`` for a lock that will
    clear, ``update_handoff_failed`` when the init system refused the job. Only
    a handoff that actually started reports one.
    """
    if os_family == 'linux':
        return _start_linux_update(installer_path)
    if os_family == 'macos':
        return _start_macos_update(installer_path)
    raise ValueError(f"No POSIX self-update path for os family '{os_family}'")


def _start_linux_update(installer_path: str) -> tuple[bool, str]:
    """apt, never `dpkg -i`: the package declares dependencies and dpkg resolves
    none of them, so a dpkg install leaves the agent unconfigured and down."""
    ready, refusal = _apt_can_install(installer_path)
    if not ready:
        return False, refusal

    started = _run_update_command(
        ['systemd-run', f'--unit={UPDATE_UNIT_NAME}', '--collect',
         '--setenv=DEBIAN_FRONTEND=noninteractive',
         '/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', installer_path],
        _UPDATE_HANDOFF_TIMEOUT,
    )
    if started is None or started.returncode != 0:
        return False, f"update_handoff_failed: {_complaint(started)[:300]}"
    return True, f"apt-get is installing the package as {UPDATE_UNIT_NAME}.service"


def _apt_can_install(installer_path: str) -> tuple[bool, str]:
    """Whether apt can satisfy the package, with one recovery attempt.

    ``--simulate`` resolves the whole dependency graph without touching the
    system, so a package whose ``Depends:`` cannot be met is refused here — with
    the installed version still running — rather than half-installed. It takes
    no lock, which is what lets it run at all while another package operation
    is under way, so the lock is a separate question: the install itself runs
    inside a transient unit whose failure nobody reads back, and unattended
    upgrades hold that lock several times a day.
    """
    if _dpkg_frontend_lock_held():
        return False, 'update_deferred: another package operation holds the dpkg lock'

    result = _run_update_command(
        ['apt-get', 'install', '--simulate', installer_path], _APT_SIMULATE_TIMEOUT)
    if result is not None and result.returncode == 0:
        return True, ''

    complaint = _complaint(result)
    lowered = complaint.lower()

    if _DPKG_INTERRUPTED_MARKER in lowered:
        logging.warning(
            "An earlier package operation was interrupted - running dpkg --configure -a")
        _run_update_command(['dpkg', '--configure', '-a'], _DPKG_CONFIGURE_TIMEOUT)
        result = _run_update_command(
            ['apt-get', 'install', '--simulate', installer_path], _APT_SIMULATE_TIMEOUT)
        if result is not None and result.returncode == 0:
            return True, ''
        complaint = _complaint(result)

    return False, f"update_unsatisfiable: {complaint[:300]}"


def _dpkg_frontend_lock_held() -> bool:
    """Whether another package operation holds apt's frontend lock.

    A POSIX record lock, which is the kind apt takes — a probe of any other
    kind contends with nothing and would report every lock free. A file that
    cannot be opened is reported as free: the install is still the authority
    on whether it can run, and refusing an update over a failed probe would be
    worse than letting apt refuse it.
    """
    import fcntl

    try:
        fd = os.open(_DPKG_FRONTEND_LOCK, os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    else:
        fcntl.lockf(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def _start_macos_update(installer_path: str) -> tuple[bool, str]:
    """`installer` as a launchd job rather than a child: the package stops the
    daemon, and `launchctl bootout` takes the daemon's whole process group.

    A job that runs once, loaded from a plist launchd reads at bootstrap. Not
    `launchctl submit`: that marks its job keepalive whatever the command
    exits with — measured on macOS 26.6, a submitted command that exited 0 was
    scheduled to run again ten seconds later — so the installer would have
    reinstalled the package, restarting the agent each time, for as long as
    the job stayed loaded. An earlier update job left loaded under the label
    is booted out first; one that is still installing defers this update
    rather than being killed mid-install.
    """
    import plistlib

    import shared_utils

    state = _update_job_state()
    if state == 'running':
        return False, 'update_deferred: an earlier update is still installing'
    if state is not None:
        _run_update_command(
            ['launchctl', 'bootout', f'system/{UPDATE_JOB_LABEL}'], _UPDATE_HANDOFF_TIMEOUT)

    log_path = shared_utils.get_data_path(_MACOS_UPDATE_LOG)
    with tempfile.TemporaryDirectory() as staging:
        plist = os.path.join(staging, f'{UPDATE_JOB_LABEL}.plist')
        with open(plist, 'wb') as f:
            plistlib.dump({
                'Label': UPDATE_JOB_LABEL,
                'ProgramArguments': [
                    '/usr/sbin/installer', '-pkg', installer_path, '-target', '/'],
                'RunAtLoad': True,
                'KeepAlive': False,
                'StandardOutPath': log_path,
                'StandardErrorPath': log_path,
            }, f)
        result = _run_update_command(
            ['launchctl', 'bootstrap', 'system', plist], _UPDATE_HANDOFF_TIMEOUT)
    if result is None or result.returncode != 0:
        return False, f"update_handoff_failed: {_complaint(result)[:300]}"
    return True, f"installer is running as the launchd job {UPDATE_JOB_LABEL}"


def _update_job_state() -> Optional[str]:
    """The update job's launchd state; None when it is not loaded at all."""
    result = _run_update_command(
        ['launchctl', 'print', f'system/{UPDATE_JOB_LABEL}'], _UPDATE_HANDOFF_TIMEOUT)
    if result is None or result.returncode != 0:
        return None
    for line in (result.stdout or '').splitlines():
        if line.startswith('\tstate = '):
            return line[len('\tstate = '):].strip()
    return 'unknown'


def _run_update_command(command: List[str], timeout_seconds: int):
    """A command's result, or None when it could not be run at all.

    The difference matters: a handoff that never reached the OS is a failure
    whatever the package manager would have said.
    """
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=timeout_seconds)
    except (OSError, subprocess.SubprocessError) as e:
        logging.warning(f"{' '.join(command)} failed: {e}")
        return None


def _complaint(result) -> str:
    """What a failed command said, stdout included — apt reports unmet
    dependencies on stdout and only the summary line on stderr."""
    if result is None:
        return 'the command could not be run'
    return f"{result.stderr or ''}{result.stdout or ''}".strip()
