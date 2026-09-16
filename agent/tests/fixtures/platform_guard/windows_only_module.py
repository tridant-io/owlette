"""Control: stands in for an exempt module — Windows-only by design.

The guard tolerates its module-scope Windows dependency because the fixture
test lists it, and rule 3 is satisfied because it really does carry one.
"""

import ctypes

import win32api

CURRENT_PROCESS = ctypes.windll.kernel32.GetCurrentProcess()
BUILD = win32api.GetVersionEx()
