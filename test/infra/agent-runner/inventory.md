# Agent runner Windows import inventory

Date: 2026-04-26

Scope: `agent/src/sync_*.py` and the imports those modules can pull in while
loading or while running the sync command path. The repository currently does
not contain `agent/src/sync_pull.py`; the `sync_pull` behavior is the command
handler `_handle_sync_pull` in `agent/src/sync_commands.py`.

## Sync modules

| Module | Module-load Windows imports | Lazy Windows imports/calls | Notes |
| --- | --- | --- | --- |
| `sync_state.py` | None | None | Pure Python plus `sqlite3`. |
| `sync_version.py` | None | None | Pure Python plus `requests`. |
| `sync_downloader.py` | None | None | Pure Python plus `requests`; POSIX-safe default content-store path exists. |
| `sync_assembler.py` | None | `_harden_acl()` imports `win32security` and `ntsecuritycon` only after `os.name == 'nt'`; long-path helpers are string-only on POSIX. | Linux tests can import and run assembly paths; ACL hardening is skipped on POSIX by existing production code. |
| `sync_commands.py` | None | `_allowlist_for()` imports `shared_utils` when a real command needs config-backed allowlist construction. | Unit tests and fake-service e2e can avoid `firebase_client`; command registration imports cleanly. |
| `sync_scrub.py` | None | None | Not part of the requested five, but it imports the same sync core and is POSIX-safe at module load. |

## Transitive sync command imports

| Module | Module-load Windows imports | Lazy Windows imports/calls | Notes |
| --- | --- | --- | --- |
| `destination_allowlist.py` | None | `_resolve_interactive_home()` imports `winreg` only when `sys.platform == 'win32'`; Windows reparse-point checks also run only on `win32`. | Safe to import and use on Linux for POSIX paths. |
| `command_router.py` | None | None | Pure Python. |
| `roost_kill_switch.py` | None | None | Pure Python; accepts fake Firestore readers. |
| `firestore_rest_client.py` | None | None | Custom Firestore REST client, not `firebase_admin`; pure Python plus `requests`. |
| `shared_utils.py` | None. | `winreg` inside `get_machine_timezone`, `get_cpu_name`, and `_get_windows_version_string`; `win32event`/`win32con` in the cross-process JSON lock; `win32gui`/`win32process` in window lookup helpers; `ctypes.windll.user32/gdi32` in DPI helpers. | Imports on Linux only with `OWLETTE_DATA_ROOT` set — `CONFIG_PATH` resolves the data root at module scope through `osadapter`, whose POSIX arm lands in Task 3.1. The Windows helpers are reached only when one is called, which is outside the sync e2e target. |
| `registry_utils.py` | `winreg` at module load. | Registry enumeration functions call `winreg.*`. | The one module-scope `winreg` consumer left; nothing on the sync path imports it. |
| `secure_storage.py` | None directly, but imports `shared_utils`. | Hidden-file attributes call `ctypes.windll.kernel32` only when `os.name == 'nt'`; the MachineGuid read lives in `osadapter/win.py`. | Token storage is not required for the fake-service sync tests. |
| `auth_manager.py` | None directly, but imports `secure_storage` and `shared_utils`. | Network/token operations only when instantiated/called. | Not imported by the sync unit modules unless `firebase_client` is used. |
| `firebase_client.py` | Imports `shared_utils`, `hardware_profile`, and `config_sync` at module load; none of them is a Linux import blocker. | `display_manager`, `nvapi_display`, and `registry_utils` are imported inside the display/hardware methods that use them; Firestore operations use the custom REST client. | Not imported by the runner entrypoint. `display_manager` stays a Linux import blocker in its own right, but it is no longer reached by importing this module. |
| `display_manager.py` | Windows CCD ctypes ABI assertions and `ctypes.windll.user32` binding at module load. | More `ctypes.windll` plus lazy `win32ts`, `win32security`, `win32profile`, `win32process`, `win32con`, and `win32event` for user-session delegation. | Excluded from the runner target; this is not needed to exercise `sync_*` modules. |
| `owlette_service.py` | `win32service`, `win32process`, `win32profile`, `win32ts`, `win32con`, and `win32security` at module load. | Additional Windows session/process calls throughout service lifecycle. | Excluded by design. It is the Windows service host, not the sync engine under test. |
