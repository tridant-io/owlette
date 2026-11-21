"""Tells the cloud a machine is going to sleep, before it goes.

A Mac on battery idle-sleeps unless keep screens awake holds it, and a closed
lid or the Apple menu sleeps it either way. The agent freezes with it, the
heartbeat goes stale, and the server pages a machine nobody can tell from a
crashed one. The system asks every power client before it sleeps; the agent
answers by marking the machine asleep, then lets the sleep go ahead.

The machine counts as asleep from that ask until a full wake. A dark wake (a
few seconds of maintenance with the displays off, every quarter hour or so on
battery) runs the agent too, and its heartbeats must still say asleep, or the
dashboard and the alert emails would see the machine wake and sleep again each
time.

macOS only so far: elsewhere nothing listens and the heartbeat carries no
asleep field.
"""

from __future__ import annotations

import ctypes
import datetime
import logging
import sys
import threading

logger = logging.getLogger(__name__)

# how long a sleep waits on the announce. the system allows 30 s for an answer;
# a write that has not landed in this is not going to.
ANNOUNCE_WAIT_SECONDS = 5.0

_AWAKE, _ASLEEP, _WAKING = 'awake', 'asleep', 'waking'


class SleepWatch:
    """Whether the machine is asleep, as its agent can tell from inside."""

    def __init__(self, backend=None):
        self._backend = backend if backend is not None else _platform_backend()
        self._lock = threading.Lock()
        self._state = _AWAKE
        self._since = None
        self._announce = None
        self.listening = False

    @property
    def supported(self):
        """Whether this platform has a power manager to listen to."""
        return self._backend is not None

    def start(self, announce):
        """Listen for system sleep on a thread of its own. Does nothing where there is nothing to listen to.

        ``announce()`` runs before each sleep, for up to ANNOUNCE_WAIT_SECONDS.
        """
        if self._backend is None or self.listening:
            return
        self._announce = announce
        self.listening = True
        threading.Thread(target=self._listen, name='sleep-watch', daemon=True).start()

    def asleep_since(self):
        """When this sleep began, from the system's will-sleep until it is fully awake again; None while awake.

        A return to sleep from a dark wake is the same sleep and keeps its time.
        """
        with self._lock:
            state, since = self._state, self._since
        if state == _AWAKE:
            return None
        # until the system says it powered on, it is still on its way down: a
        # capability read then can still see the displays on.
        if state == _ASLEEP or not self._backend.fully_awake():
            return since
        with self._lock:
            # a will-sleep that landed during the read wins.
            if self._state != _WAKING:
                return self._since
            self._state = _AWAKE
        logger.info('system awake')
        return None

    def _listen(self):
        try:
            self._backend.listen(self._will_sleep, self._powered_on)
        except Exception as e:
            self.listening = False
            logger.warning('sleep watch: not listening: %s', e)

    def _will_sleep(self):
        with self._lock:
            first = self._state == _AWAKE
            if first:
                self._since = _utcnow()
            self._state = _ASLEEP
        logger.info('system going to sleep%s', '' if first else ' again from a dark wake')
        # a thread of its own, so a stalled write never holds the sleep past the wait.
        worker = threading.Thread(target=self._announce_once, name='sleep-announce', daemon=True)
        worker.start()
        worker.join(ANNOUNCE_WAIT_SECONDS)
        if worker.is_alive():
            logger.warning('sleep watch: the announce did not land in %ss', ANNOUNCE_WAIT_SECONDS)

    def _announce_once(self):
        try:
            self._announce()
        except Exception as e:
            logger.warning('sleep watch: announce failed: %s', e)

    def _powered_on(self):
        with self._lock:
            if self._state == _ASLEEP:
                self._state = _WAKING


def _utcnow():
    # naive utc, the form the rest client writes as a timestamp
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def _platform_backend():
    return IOKitSystemPower() if sys.platform == 'darwin' else None


# --------------------------------------------------------------------- macOS

# iokit_common_msg(...): the system power messages IORegisterForSystemPower delivers.
_CAN_SYSTEM_SLEEP = 0xE0000270
_SYSTEM_WILL_SLEEP = 0xE0000280
_SYSTEM_HAS_POWERED_ON = 0xE0000300
# IOPMrootDomain's "System Capabilities": the graphics bit is off in a dark wake.
_CAPABILITY_GRAPHICS = 0x2

_MESSAGE_CALLBACK = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p)


class IOKitSystemPower:
    """macOS: IORegisterForSystemPower, served by a run loop on the listening thread."""

    def __init__(self, frameworks=None, capabilities=None):
        # (iokit, corefoundation, kCFRunLoopDefaultMode); injected by the tests,
        # loaded on first use otherwise.
        self._frameworks = frameworks
        self._capabilities = capabilities or _system_capabilities
        # the callback ctypes hands IOKit; collected, the next message would crash the agent.
        self._callback = None

    def listen(self, will_sleep, powered_on):
        """Deliver the system's power messages to the two hooks. Blocks for the life of the process."""
        iokit, cf, default_mode = self._api()
        port = ctypes.c_void_p()
        notifier = ctypes.c_uint32()
        root = 0

        def on_message(_refcon, _service, message, argument):
            try:
                if message == _SYSTEM_WILL_SLEEP:
                    will_sleep()
                elif message == _SYSTEM_HAS_POWERED_ON:
                    powered_on()
            except Exception as e:
                logger.warning('sleep watch: power message %#x failed: %s', message, e)
            finally:
                # unanswered, either one holds the sleep for 30 s.
                if message in (_CAN_SYSTEM_SLEEP, _SYSTEM_WILL_SLEEP):
                    iokit.IOAllowPowerChange(root, argument or 0)

        self._callback = _MESSAGE_CALLBACK(on_message)
        root = iokit.IORegisterForSystemPower(None, ctypes.byref(port), self._callback, ctypes.byref(notifier))
        if not root:
            raise RuntimeError('IORegisterForSystemPower failed')
        source = iokit.IONotificationPortGetRunLoopSource(port)
        cf.CFRunLoopAddSource(cf.CFRunLoopGetCurrent(), source, default_mode)
        logger.info('sleep watch: listening')
        cf.CFRunLoopRun()

    def fully_awake(self):
        """False in a dark wake. A failed read counts as awake, so it never holds a machine asleep."""
        try:
            capabilities = self._capabilities()
        except Exception as e:
            logger.debug('sleep watch: capability read failed: %s', e)
            return True
        return not isinstance(capabilities, int) or bool(capabilities & _CAPABILITY_GRAPHICS)

    def _api(self):
        if self._frameworks is None:
            self._frameworks = _iokit()
        return self._frameworks


def _system_capabilities():
    from osadapter import darwin

    return darwin._registry_property(b'IOPMrootDomain', 'System Capabilities')


def _iokit():
    """The daemon's IOKit and CoreFoundation, with the power-notification calls typed."""
    from osadapter import darwin

    iokit, cf = darwin._frameworks()
    pointer, port = ctypes.c_void_p, ctypes.c_uint32
    for function, argtypes, restype in (
        (iokit.IORegisterForSystemPower,
         [pointer, ctypes.POINTER(pointer), _MESSAGE_CALLBACK, ctypes.POINTER(port)], port),
        (iokit.IONotificationPortGetRunLoopSource, [pointer], pointer),
        (iokit.IOAllowPowerChange, [port, ctypes.c_ssize_t], ctypes.c_int),
        (cf.CFRunLoopGetCurrent, [], pointer),
        (cf.CFRunLoopAddSource, [pointer, pointer, pointer], None),
        (cf.CFRunLoopRun, [], None),
    ):
        function.argtypes, function.restype = argtypes, restype
    return iokit, cf, pointer.in_dll(cf, 'kCFRunLoopDefaultMode')


# the agent's one watch: the service starts it, every heartbeat reads it.
WATCH = SleepWatch()
