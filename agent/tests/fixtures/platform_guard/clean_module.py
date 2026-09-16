"""Control: a module the guard must accept.

Pins the two allowances that matter — `ctypes.wintypes` imports fine on POSIX
(it is pure type declarations), and a call-time `winreg` / `ctypes.windll` is
exactly the shape the guard steers Windows code towards.
"""

import ctypes
import ctypes.wintypes

HANDLE = ctypes.wintypes.HANDLE


def read_install_root():
    import winreg

    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Owlette') as key:
        return winreg.QueryValueEx(key, 'InstallRoot')[0]


def foreground_window():
    return ctypes.windll.user32.GetForegroundWindow()
