"""Lightweight process launcher helper for Owlette.

Launched by the Owlette service via CreateProcessAsUser into the user's
interactive session.

Flow:
  1. Reads launch parameters from a JSON file written by the service
  2. Launches the target process directly via ShellExecuteEx (ctypes) which:
     - Fully initializes the desktop/GPU context for apps like TouchDesigner
     - Returns the process handle so we get the PID immediately — no scanning
     - Always launches the configured exe with the file as an argument — never
       uses file association, which would trigger the Windows "Open with" dialog
     - This helper already runs in the user's session (via CreateProcessAsUser)
       so the launched process inherits full interactive desktop context
  3. For hidden processes, uses subprocess.Popen (no shell context needed)
  4. Writes the target's PID to a file for the service to read
"""
import sys
import os
import json
import ctypes
import ctypes.wintypes
import subprocess


def build_hidden_batch_command(exe_path, launch_args):
    """Build the cmd.exe command line for a hidden .bat/.cmd launch.

    .bat/.cmd can't run via CreateProcess directly (WinError 193), so they go
    through cmd.exe /c. Passing a list would let list2cmdline quote the script
    path and each spaced argument separately — and with more than two quote
    characters after /c, cmd.exe strips the first and last quote and mangles
    the command ('C:\\Program' is not recognized...). /s plus an explicit outer
    quote pair pins cmd.exe's parsing: it strips exactly that outer pair and
    executes the remainder verbatim.
    """
    # shlex.split(posix=False) keeps surrounding quotes on tokens; strip them
    # so list2cmdline re-quotes exactly once.
    normalized = [
        a[1:-1] if len(a) >= 2 and a[0] == a[-1] == '"' else a
        for a in launch_args
    ]
    inner = subprocess.list2cmdline([exe_path] + normalized)
    return f'cmd.exe /s /c "{inner}"'


def write_result(pid_file, pid=None, error=None):
    """Write launch result to PID file as JSON."""
    result = {}
    if error:
        result['error'] = str(error)
    else:
        result['pid'] = pid
    with open(pid_file, 'w') as f:
        json.dump(result, f)


def shell_execute_ex(target, parameters=None, cwd=None, visibility='Normal'):
    """Launch a process via ShellExecuteEx and return its PID.

    Uses SEE_MASK_NOCLOSEPROCESS to get the process handle back,
    then extracts the PID from it. This gives us the PID immediately
    without any scanning.

    Args:
        target: The file or executable to open (lpFile).
        parameters: Command-line arguments passed to the target (lpParameters).
        cwd: Working directory for the launched process.
        visibility: Window visibility ('Normal', 'Minimized', 'Maximized', 'Hidden').
    """
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SEE_MASK_FLAG_NO_UI = 0x00000400

    sw_map = {'Normal': 1, 'Minimized': 2, 'Maximized': 3, 'Hidden': 0}
    nShow = sw_map.get(visibility, 1)

    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", ctypes.wintypes.HANDLE),
            ("lpVerb", ctypes.c_wchar_p),
            ("lpFile", ctypes.c_wchar_p),
            ("lpParameters", ctypes.c_wchar_p),
            ("lpDirectory", ctypes.c_wchar_p),
            ("nShow", ctypes.c_int),
            ("hInstApp", ctypes.wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", ctypes.c_wchar_p),
            ("hkeyClass", ctypes.wintypes.HKEY),
            ("dwHotKey", ctypes.wintypes.DWORD),
            ("hIcon", ctypes.wintypes.HANDLE),
            ("hProcess", ctypes.wintypes.HANDLE),
        ]

    sei = SHELLEXECUTEINFO()
    sei.cbSize = ctypes.sizeof(SHELLEXECUTEINFO)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI
    sei.lpVerb = "open"
    sei.lpFile = target
    sei.lpParameters = parameters
    sei.lpDirectory = cwd
    sei.nShow = nShow
    sei.hProcess = None

    success = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei))
    if not success:
        error_code = ctypes.GetLastError()
        raise OSError(f"ShellExecuteEx failed with error code {error_code}")

    if sei.hProcess:
        pid = ctypes.windll.kernel32.GetProcessId(sei.hProcess)
        ctypes.windll.kernel32.CloseHandle(sei.hProcess)
        if pid:
            return pid

    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    args_file = sys.argv[1]

    try:
        with open(args_file, 'r') as f:
            args = json.load(f)
    except Exception:
        sys.exit(1)

    exe_path = args['exe_path']
    file_path = args.get('file_path', '')
    cwd = args.get('cwd')
    visibility = args.get('visibility', 'Normal')
    pid_file = args['pid_file']

    try:
        # exe_path is always lpFile, file_path always lpParameters. Passing the
        # document as lpFile would use file association: an "Open with" dialog
        # that ignores the exe the user configured.
        launch_target = exe_path
        parameters = None

        if file_path:
            if os.path.isfile(file_path):
                parameters = f'"{file_path}"'
            else:
                # Not a file on disk: treat as CLI arguments.
                parameters = file_path

        if visibility == 'Hidden':
            # No shell context needed when hidden — subprocess directly.
            if exe_path.lower().endswith(('.bat', '.cmd')):
                launch_args = []
                if file_path:
                    if os.path.isfile(file_path):
                        launch_args.append(file_path)
                    else:
                        import shlex
                        launch_args = shlex.split(file_path, posix=False)
                # .bat/.cmd can't run via CreateProcess (WinError 193) — wrap
                # in cmd.exe. Built as a single /s /c string, not a list: see
                # build_hidden_batch_command for the quote-stripping trap.
                cmd = build_hidden_batch_command(exe_path, launch_args)
            else:
                # the command line a shown launch gets from lpParameters: as a
                # list, a token's own quotes would reach the program escaped.
                cmd = f'"{exe_path}"' + (f' {parameters}' if parameters else '')
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags = subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE
            # CREATE_NO_WINDOW suppresses the console that a console-subsystem
            # target (.bat via cmd.exe, console .exe) would otherwise allocate
            # a visible window for; SW_HIDE alone only affects GUI windows.
            proc = subprocess.Popen(
                cmd,
                cwd=cwd or None,
                startupinfo=startupinfo,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            pid = proc.pid
        else:
            # Use ShellExecuteEx directly — this helper already runs in the
            # user's interactive session (via CreateProcessAsUser), so the
            # launched process gets full desktop/GPU context.
            pid = shell_execute_ex(launch_target, parameters=parameters, cwd=cwd, visibility=visibility)

        if pid:
            write_result(pid_file, pid=pid)
        else:
            write_result(pid_file, error="ShellExecuteEx returned no process handle")
            sys.exit(1)

    except Exception as e:
        try:
            write_result(pid_file, error=str(e))
        except Exception:
            pass
        sys.exit(1)


if __name__ == '__main__':
    main()
