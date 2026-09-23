"""Control: stands in for a Windows arm — exempt from rule 1, never imported."""

import win32api

BUILD = win32api.GetVersionEx()
