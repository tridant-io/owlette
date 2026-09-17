"""Control: rule 1 — module-scope Windows dependencies with no exemption."""

import ctypes

import winreg
import winerror
from ctypes import WinDLL

TIMEZONE_ROOT = winreg.HKEY_LOCAL_MACHINE
ALREADY_RUNNING = winerror.ERROR_SERVICE_ALREADY_RUNNING
KERNEL32 = WinDLL('kernel32')
NVAPI = ctypes.WinDLL('nvapi64.dll')


@ctypes.WINFUNCTYPE(None, ctypes.c_void_p)
def report_window(hwnd, user32=ctypes.windll.user32):
    return user32.IsWindowVisible(hwnd)
