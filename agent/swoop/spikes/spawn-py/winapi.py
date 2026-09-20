"""The Win32 surface spike 0.3 needs, through ctypes rather than pywin32.

**This module exists because of a finding, not a preference.** The product's
spawn path wants `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so
that `bInheritHandles=TRUE` hands the child exactly the pipes it is meant to get
and nothing else. pywin32 cannot express that at any installed version -- see
``handle_list_support()`` -- so the spike drives ``CreateProcessAsUserW``
directly.

Nothing here elevates. There is no ``ShellExecute``, no ``runas`` verb and no
manifest: every token is a duplicate of the one this process already holds, so
no path through this module can reach the AppInfo service and raise a consent
prompt.

No import from ``agent/src``, deliberately: the spike validates that code from
outside rather than inheriting its assumptions.
"""

import ctypes
import os
from ctypes import wintypes

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
userenv = ctypes.WinDLL('userenv', use_last_error=True)

# --- constants ---------------------------------------------------------------

HANDLE_FLAG_INHERIT = 0x0001
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
ERROR_INSUFFICIENT_BUFFER = 122
ERROR_PRIVILEGE_NOT_HELD = 1314

STARTF_USESTDHANDLES = 0x00000100
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0

CREATE_SUSPENDED = 0x00000004
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_NO_WINDOW = 0x08000000
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
NORMAL_PRIORITY_CLASS = 0x00000020

PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002

TOKEN_QUERY = 0x0008
TOKEN_DUPLICATE = 0x0002
TOKEN_ALL_ACCESS = 0xF01FF
SECURITY_IMPERSONATION = 2
TOKEN_PRIMARY = 1

TOKEN_USER = 1
TOKEN_SESSION_ID = 12
TOKEN_ELEVATION_TYPE = 18
TOKEN_ELEVATION = 20
TOKEN_INTEGRITY_LEVEL = 25

JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102

TH32CS_SNAPPROCESS = 0x00000002

# The desktop the child is spawned on. It is the *process* default only: the
# input desktop moves to Winlogon on every lock, logon screen and UAC consent
# prompt, which is what primitive (4) is about.
DESKTOP = 'WinSta0\\Default'


# --- structures --------------------------------------------------------------


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ('nLength', wintypes.DWORD),
        ('lpSecurityDescriptor', wintypes.LPVOID),
        ('bInheritHandle', wintypes.BOOL),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('lpReserved', wintypes.LPWSTR),
        ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR),
        ('dwX', wintypes.DWORD),
        ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD),
        ('dwYSize', wintypes.DWORD),
        ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD),
        ('dwFillAttribute', wintypes.DWORD),
        ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD),
        ('cbReserved2', wintypes.WORD),
        ('lpReserved2', ctypes.POINTER(ctypes.c_byte)),
        ('hStdInput', wintypes.HANDLE),
        ('hStdOutput', wintypes.HANDLE),
        ('hStdError', wintypes.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [
        ('StartupInfo', STARTUPINFOW),
        ('lpAttributeList', wintypes.LPVOID),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', wintypes.HANDLE),
        ('hThread', wintypes.HANDLE),
        ('dwProcessId', wintypes.DWORD),
        ('dwThreadId', wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ('ReadOperationCount', ctypes.c_ulonglong),
        ('WriteOperationCount', ctypes.c_ulonglong),
        ('OtherOperationCount', ctypes.c_ulonglong),
        ('ReadTransferCount', ctypes.c_ulonglong),
        ('WriteTransferCount', ctypes.c_ulonglong),
        ('OtherTransferCount', ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('PerProcessUserTimeLimit', wintypes.LARGE_INTEGER),
        ('PerJobUserTimeLimit', wintypes.LARGE_INTEGER),
        ('LimitFlags', wintypes.DWORD),
        ('MinimumWorkingSetSize', ctypes.c_size_t),
        ('MaximumWorkingSetSize', ctypes.c_size_t),
        ('ActiveProcessLimit', wintypes.DWORD),
        ('Affinity', ctypes.POINTER(ctypes.c_ulong)),
        ('PriorityClass', wintypes.DWORD),
        ('SchedulingClass', wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('BasicLimitInformation', JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ('IoInfo', IO_COUNTERS),
        ('ProcessMemoryLimit', ctypes.c_size_t),
        ('JobMemoryLimit', ctypes.c_size_t),
        ('PeakProcessMemoryUsed', ctypes.c_size_t),
        ('PeakJobMemoryUsed', ctypes.c_size_t),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize', wintypes.DWORD),
        ('cntUsage', wintypes.DWORD),
        ('th32ProcessID', wintypes.DWORD),
        ('th32DefaultHeapID', ctypes.POINTER(ctypes.c_ulong)),
        ('th32ModuleID', wintypes.DWORD),
        ('cntThreads', wintypes.DWORD),
        ('th32ParentProcessID', wintypes.DWORD),
        ('pcPriClassBase', wintypes.LONG),
        ('dwFlags', wintypes.DWORD),
        ('szExeFile', wintypes.WCHAR * 260),
    ]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [('Sid', wintypes.LPVOID), ('Attributes', wintypes.DWORD)]


# --- prototypes --------------------------------------------------------------
# Declared explicitly. A HANDLE left as the default c_int truncates on 64-bit
# and the failure looks like a random invalid-handle error much later.

kernel32.CreatePipe.argtypes = [
    ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE),
    ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.DWORD,
]
kernel32.CreatePipe.restype = wintypes.BOOL

kernel32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
kernel32.SetHandleInformation.restype = wintypes.BOOL

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

kernel32.GetCurrentProcess.argtypes = []
kernel32.GetCurrentProcess.restype = wintypes.HANDLE

kernel32.CreateEventW.argtypes = [
    ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR,
]
kernel32.CreateEventW.restype = wintypes.HANDLE

kernel32.InitializeProcThreadAttributeList.argtypes = [
    wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t),
]
kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL

kernel32.UpdateProcThreadAttribute.argtypes = [
    wintypes.LPVOID, wintypes.DWORD, ctypes.c_size_t, wintypes.LPVOID,
    ctypes.c_size_t, wintypes.LPVOID, ctypes.POINTER(ctypes.c_size_t),
]
kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL

kernel32.DeleteProcThreadAttributeList.argtypes = [wintypes.LPVOID]
kernel32.DeleteProcThreadAttributeList.restype = None

kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.POINTER(SECURITY_ATTRIBUTES),
    ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.BOOL, wintypes.DWORD,
    wintypes.LPVOID, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOEXW),
    ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wintypes.BOOL

advapi32.CreateProcessAsUserW.argtypes = [
    wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR,
    ctypes.POINTER(SECURITY_ATTRIBUTES), ctypes.POINTER(SECURITY_ATTRIBUTES),
    wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR,
    ctypes.POINTER(STARTUPINFOEXW), ctypes.POINTER(PROCESS_INFORMATION),
]
advapi32.CreateProcessAsUserW.restype = wintypes.BOOL

advapi32.OpenProcessToken.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
]
advapi32.OpenProcessToken.restype = wintypes.BOOL

advapi32.DuplicateTokenEx.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(SECURITY_ATTRIBUTES),
    ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE),
]
advapi32.DuplicateTokenEx.restype = wintypes.BOOL

advapi32.SetTokenInformation.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
]
advapi32.SetTokenInformation.restype = wintypes.BOOL

advapi32.GetTokenInformation.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
advapi32.GetTokenInformation.restype = wintypes.BOOL

userenv.CreateEnvironmentBlock.argtypes = [
    ctypes.POINTER(wintypes.LPVOID), wintypes.HANDLE, wintypes.BOOL,
]
userenv.CreateEnvironmentBlock.restype = wintypes.BOOL

userenv.DestroyEnvironmentBlock.argtypes = [wintypes.LPVOID]
userenv.DestroyEnvironmentBlock.restype = wintypes.BOOL

kernel32.WTSGetActiveConsoleSessionId.argtypes = []
kernel32.WTSGetActiveConsoleSessionId.restype = wintypes.DWORD

kernel32.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
kernel32.ProcessIdToSessionId.restype = wintypes.BOOL

kernel32.CreateJobObjectW.argtypes = [
    ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.LPCWSTR,
]
kernel32.CreateJobObjectW.restype = wintypes.HANDLE

kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
]
kernel32.SetInformationJobObject.restype = wintypes.BOOL

kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL

kernel32.IsProcessInJob.argtypes = [
    wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL),
]
kernel32.IsProcessInJob.restype = wintypes.BOOL

kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
kernel32.ResumeThread.restype = wintypes.DWORD

kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD

kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.GetExitCodeProcess.restype = wintypes.BOOL

kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32FirstW.restype = wintypes.BOOL

kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.restype = wintypes.BOOL


# --- errors ------------------------------------------------------------------


class Win32Error(Exception):
    """A Win32 call failed. ``code`` is the real ``GetLastError``."""

    def __init__(self, call, code):
        super().__init__(f'{call} failed: {code} ({os.strerror(0) if code == 0 else code})')
        self.call = call
        self.code = code


def _check(ok, call):
    if not ok:
        raise Win32Error(call, ctypes.get_last_error())
    return ok


def last_error():
    return ctypes.get_last_error()


# --- handles and pipes -------------------------------------------------------


def inheritable_sa():
    sa = SECURITY_ATTRIBUTES()
    sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
    sa.lpSecurityDescriptor = None
    sa.bInheritHandle = True
    return sa


def create_pipe():
    """An anonymous pipe with both ends inheritable. The caller clears the flag
    on the end it keeps: an inheritable parent end crosses into the child and
    the read side then never sees eof."""
    read = wintypes.HANDLE()
    write = wintypes.HANDLE()
    sa = inheritable_sa()
    _check(kernel32.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(sa), 0),
           'CreatePipe')
    return read.value, write.value


def set_inheritable(handle, inheritable):
    _check(kernel32.SetHandleInformation(
        wintypes.HANDLE(handle), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT if inheritable else 0,
    ), 'SetHandleInformation')


def close(handle):
    if handle:
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def create_canary():
    """An inheritable, already-signalled event that is deliberately left OUT of
    the handle list.

    It is the measurement: if the child can see it, the restriction is not in
    force and the child got handles the parent never meant to share. Its numeric
    value is not a secret and travels in the bundle line.
    """
    sa = inheritable_sa()
    handle = kernel32.CreateEventW(ctypes.byref(sa), True, True, None)
    _check(handle, 'CreateEventW')
    return handle


# --- the attribute list ------------------------------------------------------


class AttributeList:
    """`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, sized and filled.

    The handle array has to stay alive until `CreateProcess*` returns -- the
    attribute list stores a pointer to it, not a copy -- which is why this is an
    object and not a function.
    """

    def __init__(self, handles):
        self.handles = list(handles)
        size = ctypes.c_size_t(0)
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        if ctypes.get_last_error() != ERROR_INSUFFICIENT_BUFFER:
            raise Win32Error('InitializeProcThreadAttributeList(size)', ctypes.get_last_error())
        self._buffer = (ctypes.c_byte * size.value)()
        _check(kernel32.InitializeProcThreadAttributeList(
            self._buffer, 1, 0, ctypes.byref(size),
        ), 'InitializeProcThreadAttributeList')
        self._array = (wintypes.HANDLE * len(self.handles))(*self.handles)
        _check(kernel32.UpdateProcThreadAttribute(
            self._buffer, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            ctypes.cast(self._array, wintypes.LPVOID),
            ctypes.sizeof(self._array), None, None,
        ), 'UpdateProcThreadAttribute')

    @property
    def pointer(self):
        return ctypes.cast(self._buffer, wintypes.LPVOID)

    def close(self):
        if self._buffer is not None:
            kernel32.DeleteProcThreadAttributeList(self._buffer)
            self._buffer = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def handle_list_support():
    """Whether pywin32 can express `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.

    Returns ``(supported, version, detail)``. This is the probe behind the
    memo's finding, and it is deliberately run rather than asserted.
    """
    try:
        import win32process
    except ImportError as e:
        return False, 'not installed', str(e)
    try:
        import importlib.metadata as md
        version = md.version('pywin32')
    except Exception:
        version = 'unknown'
    si = win32process.STARTUPINFO()
    if hasattr(si, 'lpAttributeList'):
        return True, version, 'PySTARTUPINFO exposes lpAttributeList'
    try:
        si.lpAttributeList = {'handle_list': []}
        return True, version, 'lpAttributeList is assignable'
    except Exception as e:
        return False, version, f'{type(e).__name__}: {e}'


# --- tokens ------------------------------------------------------------------


def active_console_session():
    return kernel32.WTSGetActiveConsoleSessionId()


def this_session():
    session = wintypes.DWORD(0)
    kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session))
    return session.value


def duplicate_own_token(session_id):
    """Primitive (1): this process's own token, duplicated primary and pointed
    at ``session_id``.

    The exact technique in ``owlette_service._get_elevated_install_token``. No
    elevation is requested: the token handed back is the one this process
    already holds. `SetTokenInformation(TokenSessionId)` needs SE_TCB_PRIVILEGE,
    which SYSTEM has and an interactive administrator does not, so its result is
    returned rather than raised -- a run that could not retarget is still a run
    that measured everything else.

    Returns ``(token, environment, retargeted, retarget_error)``.
    """
    own = wintypes.HANDLE()
    _check(advapi32.OpenProcessToken(
        kernel32.GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, ctypes.byref(own),
    ), 'OpenProcessToken')
    token = wintypes.HANDLE()
    try:
        _check(advapi32.DuplicateTokenEx(
            own, TOKEN_ALL_ACCESS, None, SECURITY_IMPERSONATION, TOKEN_PRIMARY,
            ctypes.byref(token),
        ), 'DuplicateTokenEx')
    finally:
        close(own.value)

    wanted = wintypes.DWORD(session_id)
    retargeted = bool(advapi32.SetTokenInformation(
        token, TOKEN_SESSION_ID, ctypes.byref(wanted), ctypes.sizeof(wanted),
    ))
    retarget_error = 0 if retargeted else ctypes.get_last_error()

    environment = wintypes.LPVOID()
    if not userenv.CreateEnvironmentBlock(ctypes.byref(environment), token, False):
        environment = wintypes.LPVOID()
    return token.value, environment, retargeted, retarget_error


def token_identity(token):
    """The user sid, integrity level, elevation type and session of a token."""
    return {
        'userSid': _sid_from_token(token, TOKEN_USER),
        'integritySid': _sid_from_token(token, TOKEN_INTEGRITY_LEVEL),
        'elevationType': _dword_from_token(token, TOKEN_ELEVATION_TYPE),
        'elevated': bool(_dword_from_token(token, TOKEN_ELEVATION)),
        'sessionId': _dword_from_token(token, TOKEN_SESSION_ID),
    }


def _token_info(token, info_class):
    needed = wintypes.DWORD(0)
    advapi32.GetTokenInformation(wintypes.HANDLE(token), info_class, None, 0, ctypes.byref(needed))
    if needed.value == 0:
        return None
    buffer = (ctypes.c_byte * needed.value)()
    if not advapi32.GetTokenInformation(
        wintypes.HANDLE(token), info_class, buffer, needed, ctypes.byref(needed),
    ):
        return None
    return buffer


def _dword_from_token(token, info_class):
    buffer = _token_info(token, info_class)
    if buffer is None or len(buffer) < 4:
        return None
    return int.from_bytes(bytes(buffer[:4]), 'little')


def _sid_from_token(token, info_class):
    buffer = _token_info(token, info_class)
    if buffer is None:
        return 'unknown'
    entry = SID_AND_ATTRIBUTES.from_buffer(buffer)
    if not entry.Sid:
        return 'unknown'
    return sid_to_string(entry.Sid)


def sid_to_string(pointer):
    """``S-1-5-18`` from a raw SID.

    Hand-rolled rather than `ConvertSidToStringSidW` so there is no `LocalFree`
    to get wrong and the formatting is testable without a token.
    """
    header = ctypes.string_at(pointer, 8)
    return format_sid(header + ctypes.string_at(pointer + 8, header[1] * 4))


def format_sid(raw):
    """The SID wire layout: revision, sub-authority count, a six-byte big-endian
    identifier authority, then that many little-endian sub-authorities."""
    if len(raw) < 8:
        return 'unknown'
    revision = raw[0]
    count = raw[1]
    authority = int.from_bytes(raw[2:8], 'big')
    parts = [f'S-{revision}-{authority}']
    for i in range(count):
        at = 8 + i * 4
        if at + 4 > len(raw):
            break
        parts.append(str(int.from_bytes(raw[at:at + 4], 'little')))
    return '-'.join(parts)


# --- spawning ----------------------------------------------------------------


def make_startupinfo(std_in, std_out, std_err, attribute_list, desktop=DESKTOP):
    """Primitive (2)'s `STARTUPINFOEX`: the desktop, the three std handles and
    the handle list, and nothing else."""
    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    si.StartupInfo.lpDesktop = desktop
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    si.StartupInfo.wShowWindow = SW_HIDE
    si.StartupInfo.hStdInput = std_in
    si.StartupInfo.hStdOutput = std_out
    si.StartupInfo.hStdError = std_err
    si.lpAttributeList = attribute_list.pointer if attribute_list else None
    return si


def spawn(command_line, startup_info, token=None, environment=None, suspended=True):
    """`CreateProcessAsUserW`, or `CreateProcessW` when ``token`` is None.

    ``bInheritHandles`` is TRUE either way -- it is the whole reason the helper
    exists, and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` is what makes TRUE safe.
    Returns ``(process, thread, pid)``; the caller owns all three.
    """
    flags = (
        NORMAL_PRIORITY_CLASS
        | CREATE_NO_WINDOW
        | CREATE_UNICODE_ENVIRONMENT
        | EXTENDED_STARTUPINFO_PRESENT
    )
    if suspended:
        flags |= CREATE_SUSPENDED
    info = PROCESS_INFORMATION()
    buffer = ctypes.create_unicode_buffer(command_line)
    if token is None:
        ok = kernel32.CreateProcessW(
            None, buffer, None, None, True, flags,
            environment, None, ctypes.byref(startup_info), ctypes.byref(info),
        )
        _check(ok, 'CreateProcessW')
    else:
        ok = advapi32.CreateProcessAsUserW(
            wintypes.HANDLE(token), None, buffer, None, None, True, flags,
            environment, None, ctypes.byref(startup_info), ctypes.byref(info),
        )
        _check(ok, 'CreateProcessAsUserW')
    return info.hProcess, info.hThread, info.dwProcessId


def create_kill_on_close_job():
    """Primitive (3): a job whose close terminates everything in it."""
    job = kernel32.CreateJobObjectW(None, None)
    _check(job, 'CreateJobObjectW')
    limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    _check(kernel32.SetInformationJobObject(
        wintypes.HANDLE(job), JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ctypes.byref(limits), ctypes.sizeof(limits),
    ), 'SetInformationJobObject')
    return job


def assign_to_job(job, process):
    _check(kernel32.AssignProcessToJobObject(
        wintypes.HANDLE(job), wintypes.HANDLE(process),
    ), 'AssignProcessToJobObject')


def in_job(job, process):
    result = wintypes.BOOL(False)
    _check(kernel32.IsProcessInJob(
        wintypes.HANDLE(process), wintypes.HANDLE(job), ctypes.byref(result),
    ), 'IsProcessInJob')
    return bool(result.value)


def resume(thread):
    if kernel32.ResumeThread(wintypes.HANDLE(thread)) == 0xFFFFFFFF:
        raise Win32Error('ResumeThread', ctypes.get_last_error())


def wait(process, timeout_s):
    result = kernel32.WaitForSingleObject(wintypes.HANDLE(process), int(timeout_s * 1000))
    if result != WAIT_OBJECT_0:
        return None
    code = wintypes.DWORD(0)
    kernel32.GetExitCodeProcess(wintypes.HANDLE(process), ctypes.byref(code))
    return code.value


def running_processes():
    """Every running process as ``{pid: name}``.

    Used for one thing: watching for ``consent.exe``, which is the UAC prompt.
    Its absence across a spawn window is the observable half of primitive (6).
    """
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        raise Win32Error('CreateToolhelp32Snapshot', ctypes.get_last_error())
    found = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(wintypes.HANDLE(snapshot), ctypes.byref(entry))
        while ok:
            found[entry.th32ProcessID] = entry.szExeFile
            ok = kernel32.Process32NextW(wintypes.HANDLE(snapshot), ctypes.byref(entry))
    finally:
        close(snapshot)
    return found
