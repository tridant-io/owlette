"""Notices a desktop app that has stopped running without exiting, and
replaces it.

macOS suspends apps when it runs out of application memory, and nothing
resumes one that lives only in the menu bar. Its pid stays, its icon stays on
screen, and every job the daemon queues for the session goes unanswered: a Mac
sat that way for 29 hours (2026-11-21) while its agent stayed online. The
process's state does not show it, a suspended task reads as sleeping. Its
context switches do: a running app makes dozens a second from its tray and
keep-awake threads alone and a suspended one makes none, so a count that
stands still across several reads is a process that is not running.

macOS only: the restart is launchd's, and no other system has been seen to
suspend the app.
"""

from __future__ import annotations

import logging
import subprocess

import psutil

logger = logging.getLogger(__name__)

# reads in a row that must find the count unchanged. at the service's
# DESKTOP_FREEZE_CHECK_INTERVAL_SECONDS that is two minutes without one
# context switch.
FLAT_READS_TO_FROZEN = 4
# the LaunchAgent that keeps the app in each login session
# (agent/packaging/macos/app.owlette.desktop.plist).
DESKTOP_JOB_LABEL = 'app.owlette.desktop'
_KILL_WAIT_SECONDS = 10
_LAUNCHCTL_TIMEOUT_SECONDS = 30


def read_activity(pid):
    """``(started, switches)``: which process `pid` names and how many context
    switches it has made; None when it is gone or cannot be read."""
    try:
        process = psutil.Process(pid)
        switches = process.num_ctx_switches()
        return process.create_time(), switches.voluntary + switches.involuntary
    except psutil.Error:
        return None


class FreezeWatch:
    """Counts the reads in a row in which one process made no context switch."""

    def __init__(self):
        self._seen = None
        self._flat = 0

    def frozen(self, pid, activity):
        """True once `pid` has stood still for FLAT_READS_TO_FROZEN reads.

        `activity` is read_activity's answer. Another process under the pid, a
        count that moved, or no answer starts the count again.
        """
        seen = (pid, *activity) if activity is not None else None
        self._flat = self._flat + 1 if seen is not None and seen == self._seen else 0
        self._seen = seen
        return self._flat >= FLAT_READS_TO_FROZEN

    def reset(self):
        self._seen = None
        self._flat = 0


def restart(pid, started):
    """Kill the frozen app and have launchd put one back in its user's session;
    True once launchd took the order.

    Killed by pid rather than with `kickstart -k`: an app the user opened from
    the Dock is not launchd's process, and a second instance started beside a
    frozen one hands over to it and exits. `started` is the process the watch
    saw, so a pid that has changed hands since is left alone.
    """
    try:
        process = psutil.Process(pid)
        if process.create_time() != started:
            return False
        uid = process.uids().real
        process.kill()
        process.wait(_KILL_WAIT_SECONDS)
    except psutil.Error as e:
        logger.warning(f"Could not kill the frozen desktop app (PID {pid}): {e}")
        return False

    target = f'gui/{uid}/{DESKTOP_JOB_LABEL}'
    try:
        result = subprocess.run(
            ['launchctl', 'kickstart', target],
            capture_output=True, text=True, timeout=_LAUNCHCTL_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"launchctl kickstart {target} failed: {e}")
        return False
    if result.returncode != 0:
        logger.warning(
            f"launchctl kickstart {target} exited {result.returncode}: "
            f"{(result.stderr or result.stdout).strip()}"
        )
        return False
    return True
