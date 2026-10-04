"""The daemon's hold on the displays and the system, on every platform the agent runs on.

A site switch ("keep screens awake") asks every machine to never sleep, blank
or lock. This is the half the service holds itself, which works with nobody
logged in: a power request on Windows, two IOKit assertions on macOS, and a
`systemd-inhibit` child on Linux. Each dies with the agent's process, so a
crash never leaves a machine held. The session half (the idle lock, the
screensaver) is the desktop app's.

`KeepAwake.set_wanted` returns at once; the OS calls run on one daemon thread
of its own, so the service's 5 s loop never waits on them.
"""

from __future__ import annotations

import ctypes
import logging
import os
import shutil
import subprocess
import sys
import threading

logger = logging.getLogger(__name__)

# what each OS's own inspector shows beside the hold: `powercfg /requests`,
# `pmset -g assertions`, `systemd-inhibit --list`.
_WHO = 'owlette'
_WHY = 'keep screens awake'
_NAME = f'{_WHO} {_WHY}'

# how long release() waits for the let-go on the shutdown path, which has ~5 s in all.
RELEASE_WAIT_SECONDS = 2.0


class KeepAwake:
    """Holds the machine awake while wanted. Every method returns at once but release()."""

    def __init__(self, backend=None):
        self._backend = backend or _platform_backend()
        self._lock = threading.Lock()
        self._wanted = False
        # set by set_wanted, taken by the worker: a change it has not acted on yet.
        self._dirty = False
        self._handle = None
        self._reason = None
        self._worker = None

    def set_wanted(self, wanted):
        """Ask for the hold (True) or its release (False). Returns without waiting.

        Asking again for a hold that failed tries it again.
        """
        with self._lock:
            self._wanted = bool(wanted)
            self._dirty = True
            if self._worker is None:
                worker = threading.Thread(target=self._run, name='keep-awake', daemon=True)
                worker.start()
                # after start(), so one that fails to start leaves no worker to wait on.
                self._worker = worker

    def release(self, timeout=RELEASE_WAIT_SECONDS):
        """Let go for the service's exit, waiting up to ``timeout`` for it."""
        self.set_wanted(False)
        with self._lock:
            worker = self._worker
        if worker is not None:
            worker.join(timeout)

    def status(self):
        """``{wanted, held, how, reason}``; ``reason`` says why a wanted hold is not held, else None."""
        with self._lock:
            return {
                'wanted': self._wanted,
                'held': self._handle is not None,
                'how': self._backend.how,
                'reason': self._reason,
            }

    def _run(self):
        while True:
            with self._lock:
                # the exit is decided under the lock set_wanted takes, so a change
                # that lands now either is seen here or starts a new worker.
                if not self._dirty:
                    self._worker = None
                    return
                self._dirty = False
                wanted, handle = self._wanted, self._handle
            if wanted and handle is None:
                self._hold()
            elif not wanted:
                self._let_go(handle)

    def _hold(self):
        try:
            handle, reason = self._backend.hold(), None
            logger.info('keep awake: held (%s)', self._backend.how)
        except Exception as e:
            handle, reason = None, str(e) or type(e).__name__
            logger.warning('keep awake: could not hold (%s): %s', self._backend.how, reason)
        with self._lock:
            self._handle, self._reason = handle, reason

    def _let_go(self, handle):
        if handle is not None:
            try:
                self._backend.release(handle)
                logger.info('keep awake: released (%s)', self._backend.how)
            except Exception as e:
                # the handle is spent either way; a retry has nothing left to release.
                logger.warning('keep awake: release failed (%s): %s', self._backend.how, e)
        with self._lock:
            # a hold nobody wants needs no reason, a failed one included.
            self._handle, self._reason = None, None


def _platform_backend():
    if sys.platform == 'win32':
        return PowerRequest()
    if sys.platform == 'darwin':
        return IOPMAssertion()
    return SystemdInhibit()


# ------------------------------------------------------------------- windows

_POWER_REQUEST_CONTEXT_VERSION = 0
_POWER_REQUEST_CONTEXT_SIMPLE_STRING = 0x1
_POWER_REQUEST_DISPLAY_REQUIRED = 0
_POWER_REQUEST_SYSTEM_REQUIRED = 1
_POWER_REQUEST_TYPES = (_POWER_REQUEST_DISPLAY_REQUIRED, _POWER_REQUEST_SYSTEM_REQUIRED)
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _ReasonDetailed(ctypes.Structure):
    _fields_ = [
        ('LocalizedReasonModule', ctypes.c_void_p),
        ('LocalizedReasonId', ctypes.c_ulong),
        ('ReasonStringCount', ctypes.c_ulong),
        ('ReasonStrings', ctypes.c_void_p),
    ]


class _Reason(ctypes.Union):
    _fields_ = [('Detailed', _ReasonDetailed), ('SimpleReasonString', ctypes.c_wchar_p)]


class _ReasonContext(ctypes.Structure):
    """REASON_CONTEXT, sized with its full union though only the simple string is used."""

    _fields_ = [('Version', ctypes.c_ulong), ('Flags', ctypes.c_ulong), ('Reason', _Reason)]


class PowerRequest:
    """Windows: one power request asking for the display and the system."""

    how = 'power_request'

    def __init__(self, kernel32=None, last_error=None):
        # injected by the tests; the real ones are windows-only and load on first use.
        self._kernel32 = kernel32
        self._last_error = last_error or _win_last_error

    def hold(self):
        kernel32 = self._api()
        context = _ReasonContext(_POWER_REQUEST_CONTEXT_VERSION, _POWER_REQUEST_CONTEXT_SIMPLE_STRING)
        context.Reason.SimpleReasonString = _NAME
        request = kernel32.PowerCreateRequest(ctypes.pointer(context))
        if not request or request == _INVALID_HANDLE_VALUE:
            raise RuntimeError(f'PowerCreateRequest: {self._last_error()}')
        for kind in _POWER_REQUEST_TYPES:
            if not kernel32.PowerSetRequest(request, kind):
                error = f'PowerSetRequest: {self._last_error()}'
                # closing the handle ends whatever part of the request was set.
                kernel32.CloseHandle(request)
                raise RuntimeError(error)
        return request

    def release(self, request):
        kernel32 = self._api()
        for kind in _POWER_REQUEST_TYPES:
            kernel32.PowerClearRequest(request, kind)
        # a failed clear is harmless: the request ends with its handle.
        if not kernel32.CloseHandle(request):
            raise RuntimeError(f'CloseHandle: {self._last_error()}')

    def _api(self):
        if self._kernel32 is None:
            self._kernel32 = _kernel32()
        return self._kernel32


def _kernel32():
    """kernel32's power-request calls, typed on a private handle to the dll."""
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    for function, argtypes, restype in (
        (kernel32.PowerCreateRequest, [ctypes.POINTER(_ReasonContext)], wintypes.HANDLE),
        (kernel32.PowerSetRequest, [wintypes.HANDLE, ctypes.c_int], wintypes.BOOL),
        (kernel32.PowerClearRequest, [wintypes.HANDLE, ctypes.c_int], wintypes.BOOL),
        (kernel32.CloseHandle, [wintypes.HANDLE], wintypes.BOOL),
    ):
        function.argtypes, function.restype = argtypes, restype
    return kernel32


def _win_last_error():
    return str(ctypes.WinError(ctypes.get_last_error()))


# --------------------------------------------------------------------- macOS

_ASSERTION_TYPES = (b'PreventUserIdleDisplaySleep', b'PreventUserIdleSystemSleep')
_ASSERTION_LEVEL_ON = 255
_CF_STRING_ENCODING_UTF8 = 0x08000100


class IOPMAssertion:
    """macOS: two IOKit assertions, the display's idle sleep and the system's."""

    how = 'iopm_assertion'

    def __init__(self, frameworks=None):
        # (iokit, corefoundation); injected by the tests, loaded on first use otherwise.
        self._frameworks = frameworks

    def hold(self):
        iokit, cf = self._api()
        held = []
        name = _cf_string(cf, _NAME.encode())
        try:
            for kind in _ASSERTION_TYPES:
                cf_kind = _cf_string(cf, kind)
                assertion = ctypes.c_uint32(0)
                try:
                    code = iokit.IOPMAssertionCreateWithName(
                        cf_kind, _ASSERTION_LEVEL_ON, name, ctypes.pointer(assertion))
                finally:
                    cf.CFRelease(cf_kind)
                if code:
                    for done in held:
                        iokit.IOPMAssertionRelease(done)
                    raise RuntimeError(
                        f'IOPMAssertionCreateWithName {kind.decode()}: iokit {code & 0xFFFFFFFF:#x}')
                held.append(assertion.value)
        finally:
            cf.CFRelease(name)
        return held

    def release(self, held):
        iokit, _ = self._api()
        codes = [iokit.IOPMAssertionRelease(assertion) for assertion in held]
        failed = [f'{code & 0xFFFFFFFF:#x}' for code in codes if code]
        if failed:
            raise RuntimeError(f'IOPMAssertionRelease: iokit {", ".join(failed)}')

    def _api(self):
        if self._frameworks is None:
            self._frameworks = _iokit()
        return self._frameworks


def _cf_string(cf, text):
    value = cf.CFStringCreateWithCString(None, text, _CF_STRING_ENCODING_UTF8)
    if not value:
        raise RuntimeError('CFStringCreateWithCString failed')
    return value


def _iokit():
    """The daemon's IOKit and CoreFoundation, with the two assertion calls typed."""
    from osadapter import darwin

    iokit, cf = darwin._frameworks()
    pointer = ctypes.c_void_p
    iokit.IOPMAssertionCreateWithName.argtypes = [
        pointer, ctypes.c_uint32, pointer, ctypes.POINTER(ctypes.c_uint32)]
    iokit.IOPMAssertionCreateWithName.restype = ctypes.c_int
    iokit.IOPMAssertionRelease.argtypes = [ctypes.c_uint32]
    iokit.IOPMAssertionRelease.restype = ctypes.c_int
    return iokit, cf


# --------------------------------------------------------------------- linux

# systemd-inhibit holds logind's locks for as long as its command runs. the
# agent's unit is KillMode=process, so a plain child would outlive a stop:
# `tail --pid` ends with the agent instead, and systemd-inhibit with it.
_INHIBIT_WHAT = 'sleep:idle:handle-lid-switch'
# a refusal (no system bus, no polkit grant) is an exit within this.
_INHIBIT_SETTLE_SECONDS = 1.0
_INHIBIT_STOP_SECONDS = 2.0


class SystemdInhibit:
    """Linux: a systemd-inhibit child holding sleep, idle and the lid switch."""

    how = 'systemd_inhibit'

    def __init__(self, which=None, popen=None):
        # injected by the tests.
        self._which = which or shutil.which
        self._popen = popen or subprocess.Popen

    def hold(self):
        inhibit = self._which('systemd-inhibit')
        if inhibit is None:
            raise RuntimeError('no_inhibit')
        argv = [
            inhibit, f'--what={_INHIBIT_WHAT}', f'--who={_WHO}', f'--why={_WHY}', '--mode=block',
            'tail', f'--pid={os.getpid()}', '-f', '/dev/null',
        ]
        try:
            child = self._popen(
                argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except OSError as e:
            raise RuntimeError(f'systemd-inhibit: {e}') from e
        try:
            code = child.wait(timeout=_INHIBIT_SETTLE_SECONDS)
        except subprocess.TimeoutExpired:
            # still running: the locks are held. nothing reads stderr from here on.
            child.stderr.close()
            return child
        detail = child.stderr.read().decode(errors='replace').strip().splitlines()
        child.stderr.close()
        raise RuntimeError(f'systemd-inhibit exited {code}' + (f': {detail[-1]}' if detail else ''))

    def release(self, child):
        # systemd-inhibit forks its command with a parent-death signal, so tail goes with it.
        child.terminate()
        try:
            child.wait(timeout=_INHIBIT_STOP_SECONDS)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=_INHIBIT_STOP_SECONDS)
